/**
 * 进度旁白投影单元。
 *
 * 为什么是投影而不是冷读：DSH 官方规范（defensive-patterns/conversation-and-session.zh.md）
 * 明确「冷读是最后手段」，缓存判断的 else 分支直接打开完整日志即属违规。
 * 子会话日志解压后可达数 MB，父代理每调一次工具都付这个代价会明显拖慢会话。
 * 所以这里注册一个纯单元，由框架订阅 session/event 折叠，值常驻内存。
 *
 * 硬约束（违反会让框架的增量驱动退化为全量重算）：
 * - apply 必须是纯函数：禁止网络、文件 I/O、Date.now()
 * - 时间戳一律取 event.time，不读系统时钟
 * - 不改变入参，未变化时返回原引用（框架用 Object.is 判定是否需要通知）
 */

/** 投影 key。运行时没有 key 白名单，但同 key 多处注册需 stateVersion 一致。 */
export const PROJECTION_KEY = 'what-sub-agents-doing-now';

/** 状态版本。序列化字段或折叠语义变化时必须自增。
 *
 * v2：新增 settled（子代理结算记录）。
 */
export const STATE_VERSION = 2;

/** 每个子会话保留的旁白条数上限（内部安全阀，不暴露给模型）。 */
export const MAX_NARRATION = 200;

/** 单条旁白保留的最大字符数，超出截断。 */
export const MAX_NARRATION_CHARS = 200;

/** 单个工具名保留的最大字符数。 */
const MAX_TOOL_NAME_CHARS = 64;

/**
 * 初始状态。空数组/0，不依赖任何外部输入。
 *
 * settled 记录**本会话作为父级收到过的子代理结算消息**。投射单元对每个
 * session 的事件都会跑，所以它同时在父会话上运转，能顺手截获
 * agent/inbox/spliced 里的 subagent-settled 通知——那是子代理结束后
 * 唯一还留有它收尾语的载体（子会话此时已被卸载）。
 *
 * @param {object} _header - SessionHeader，本单元不需要。
 * @param {number} _inheritedEventCount - fork 继承的事件数，本单元不需要。
 */
export function initState(_header, _inheritedEventCount) {
  return {
    narration: [],
    lastTool: undefined,
    steps: 0,
    lastAt: 0,
    lastSeq: -1,
    /** @type {Array<{childId: string, time: number, text: string}>} */
    settled: [],
  };
}

/** 结算记录的上限，防止长会话无限累积。 */
export const MAX_SETTLED = 50;

/** 单条收尾语保留的字符数。 */
const MAX_SETTLE_CHARS = 300;

/**
 * 从一条 inbox 消息里提取子代理收尾语。
 *
 * 结算通知的形状（实测）：
 *   content: [
 *     { type:'text', text:'Background subagent <id> finished and ...' },
 *     { type:'text', text:'Its closing message:' },
 *     { type:'text', text:'英语完成，共 60 题。' },
 *   ]
 *   source: { kind:'subagent-settled', senderSessionId:'<childId>' }
 *
 * @param {unknown} message - agent/inbox/spliced 的 inserted 数组元素。
 * @returns {{childId: string, text: string}|undefined}
 */
export function extractSettlement(message) {
  if (message === null || typeof message !== 'object') return undefined;
  const source = message.source;
  if (source === null || typeof source !== 'object') return undefined;
  if (source.kind !== 'subagent-settled') return undefined;

  const childId = source.senderSessionId;
  if (typeof childId !== 'string' || childId.length === 0) return undefined;

  const content = message.content;
  if (!Array.isArray(content)) return undefined;

  const texts = content
    .filter((c) => c !== null && typeof c === 'object' && c.type === 'text')
    .map((c) => (typeof c.text === 'string' ? c.text.trim() : ''))
    .filter((t) => t.length > 0);

  // 找 "Its closing message:" / "它的收尾消息:" 之后的那段
  const marker = texts.findIndex((t) => /closing message|收尾消息/i.test(t));
  const closing = marker >= 0 ? texts[marker + 1] : undefined;

  // 没留收尾语时退回 summary，至少说明它结束了
  const text = closing ?? (typeof source.summary === 'string' ? source.summary : '');
  if (text.length === 0) return undefined;

  return {
    childId,
    text: text.length > MAX_SETTLE_CHARS ? `${text.slice(0, MAX_SETTLE_CHARS - 1)}…` : text,
  };
}

/**
 * 从 assistant 消息里抽出旁白文本。
 *
 * 只取 type === 'text' 的 block。reasoning 必须排除：实测单条 reasoning
 * 可达 2000+ 字符，混进返回体会撑爆父代理的上下文，而且它是思考过程，
 * 不是子代理"说了什么"。
 *
 * @param {unknown} message - assistant/message 事件的 message 字段。
 * @returns {string[]} 非空的 text block 内容。
 */
export function extractNarrationTexts(message) {
  if (message === null || typeof message !== 'object') return [];
  const content = message.content;
  if (!Array.isArray(content)) return [];

  const out = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type !== 'text') continue;
    const text = block.text;
    if (typeof text !== 'string') continue;
    const trimmed = text.trim();
    if (trimmed.length === 0) continue;
    out.push(trimmed);
  }
  return out;
}

/**
 * 截断单条文本，保留可读性。
 * @param {string} text
 * @returns {string}
 */
function clampText(text) {
  if (text.length <= MAX_NARRATION_CHARS) return text;
  return text.slice(0, MAX_NARRATION_CHARS - 1) + '…';
}

/**
 * 往环形缓冲追加一条旁白，超出上限丢最老的。
 * @param {Array} list - 现有数组（不修改）。
 * @param {{seq: number, time: number, text: string}} entry
 * @returns {Array} 新数组。
 */
function appendBounded(list, entry) {
  const next = list.length >= MAX_NARRATION
    ? list.slice(list.length - MAX_NARRATION + 1)
    : list.slice();
  next.push(entry);
  return next;
}

/**
 * 追加一条结算记录，同一子代理只保留最新一条。
 * @param {Array} list - 现有数组（不修改）。
 * @param {{childId: string, time: number, text: string}} entry
 * @returns {Array} 新数组。
 */
function appendSettled(list, entry) {
  const filtered = list.filter((item) => item.childId !== entry.childId);
  const next = filtered.length >= MAX_SETTLED
    ? filtered.slice(filtered.length - MAX_SETTLED + 1)
    : filtered.slice();
  next.push(entry);
  return next;
}

/**
 * 折叠一个事件。
 *
 * 只关心四类事件：
 * - assistant/message：抽旁白
 * - tool/call：记工具名 + 步数
 * - step/start|step/end|turn/start：刷新活动时间
 * - agent/inbox/spliced：截获子代理结算消息（本会话作为父级时）
 *
 * 其余事件直接返回原引用，避免无谓的引用变化触发通知。
 *
 * @param {object} state - 当前状态。
 * @param {{type: string, seq: number, time: number, data?: any}} event - 已提交事件。
 * @returns {object} 新状态或原状态引用。
 */
export function applyEvent(state, event) {
  if (event === null || typeof event !== 'object') return state;
  const type = event.type;
  const seq = typeof event.seq === 'number' ? event.seq : state.lastSeq;
  const time = typeof event.time === 'number' ? event.time : state.lastAt;

  // 子代理结算消息落在父会话里。子会话此时已卸载，这是唯一还能拿到收尾语的地方。
  if (type === 'agent/inbox/spliced') {
    const inserted = event.data?.inserted;
    if (!Array.isArray(inserted)) return state;
    let settled = state.settled;
    for (const message of inserted) {
      const found = extractSettlement(message);
      if (found === undefined) continue;
      settled = appendSettled(settled, { ...found, time });
    }
    return settled === state.settled ? state : { ...state, settled };
  }

  if (type === 'assistant/message') {
    const texts = extractNarrationTexts(event.data?.message);
    if (texts.length === 0) {
      // 只有 reasoning 或只带工具调用的消息：仍然算活动，但不产生旁白。
      return time === state.lastAt && seq === state.lastSeq
        ? state
        : { ...state, lastAt: time, lastSeq: seq };
    }
    let narration = state.narration;
    for (const text of texts) {
      narration = appendBounded(narration, {
        seq,
        time,
        text: clampText(text),
      });
    }
    return { ...state, narration, lastAt: time, lastSeq: seq };
  }

  if (type === 'tool/call') {
    const rawName = event.data?.name;
    const name = typeof rawName === 'string' && rawName.length > 0
      ? rawName.slice(0, MAX_TOOL_NAME_CHARS)
      : state.lastTool;
    return {
      ...state,
      lastTool: name,
      steps: state.steps + 1,
      lastAt: time,
      lastSeq: seq,
    };
  }

  if (type === 'step/start' || type === 'step/end' || type === 'turn/start' || type === 'turn/end') {
    if (time === state.lastAt && seq === state.lastSeq) return state;
    return { ...state, lastAt: time, lastSeq: seq };
  }

  return state;
}
