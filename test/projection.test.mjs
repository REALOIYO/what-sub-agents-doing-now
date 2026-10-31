/**
 * 投影折叠逻辑的离线单测。
 *
 * 只覆盖纯函数部分（projection.js / collect.js 的纯逻辑），
 * 不依赖 DSH 运行时，node 直接跑。
 *
 *   node test/projection.test.mjs
 */

import assert from 'node:assert/strict';
import {
  PROJECTION_KEY,
  STATE_VERSION,
  MAX_NARRATION,
  MAX_NARRATION_CHARS,
  MAX_SETTLED,
  initState,
  extractNarrationTexts,
  extractSettlement,
  extractStopReason,
  applyEvent,
} from '../lib/projection.js';
import { pageNarration, clampLimit, countSince, SeenCursor, DEFAULT_LIMIT, MAX_LIMIT, classifyState } from '../lib/paginate.js';
import { buildRow } from '../lib/collect.js';

let passed = 0;
let failed = 0;

function test(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${label}`);
    console.log(`       ${error.message}`);
  }
}

function assistantEvent(seq, time, blocks) {
  return { type: 'assistant/message', seq, time, data: { message: { content: blocks } } };
}

console.log('\n=== 常量 ===');
test('PROJECTION_KEY 是字符串', () => {
  assert.equal(typeof PROJECTION_KEY, 'string');
  assert.ok(PROJECTION_KEY.length > 0);
});
test('STATE_VERSION 是非负整数', () => {
  assert.ok(Number.isInteger(STATE_VERSION) && STATE_VERSION >= 0);
});

console.log('\n=== initState ===');
test('初始状态为空', () => {
  const st = initState({}, 0);
  assert.deepEqual(st.narration, []);
  assert.equal(st.steps, 0);
  assert.equal(st.lastTool, undefined);
  assert.equal(st.lastAt, 0);
});
test('两次 init 返回独立对象', () => {
  const a = initState({}, 0);
  const b = initState({}, 0);
  assert.notEqual(a, b);
  assert.notEqual(a.narration, b.narration);
});

console.log('\n=== extractNarrationTexts ===');
test('只取 text block', () => {
  const texts = extractNarrationTexts({
    content: [
      { type: 'reasoning', text: '想很久很久……' },
      { type: 'text', text: '数学完成，共 23 题' },
      { type: 'tool-call', name: 'write' },
    ],
  });
  assert.deepEqual(texts, ['数学完成，共 23 题']);
});
test('排除 reasoning（关键安全项）', () => {
  const texts = extractNarrationTexts({
    content: [{ type: 'reasoning', text: 'x'.repeat(5000) }],
  });
  assert.deepEqual(texts, []);
});
test('跳过空白 text', () => {
  const texts = extractNarrationTexts({
    content: [{ type: 'text', text: '   \n  ' }, { type: 'text', text: 'real' }],
  });
  assert.deepEqual(texts, ['real']);
});
test('畸形输入不抛错', () => {
  assert.deepEqual(extractNarrationTexts(null), []);
  assert.deepEqual(extractNarrationTexts({}), []);
  assert.deepEqual(extractNarrationTexts({ content: 'nope' }), []);
  assert.deepEqual(extractNarrationTexts({ content: [null, 42, { type: 'text' }] }), []);
});

console.log('\n=== applyEvent ===');
test('assistant/message 累积旁白', () => {
  let st = initState({}, 0);
  st = applyEvent(st, assistantEvent(1, 1000, [{ type: 'text', text: 'step one' }]));
  st = applyEvent(st, assistantEvent(2, 2000, [{ type: 'text', text: 'step two' }]));
  assert.equal(st.narration.length, 2);
  assert.equal(st.narration[0].text, 'step one');
  assert.equal(st.narration[1].text, 'step two');
  assert.equal(st.lastAt, 2000);
});
test('tool/call 计步并记工具名', () => {
  let st = initState({}, 0);
  st = applyEvent(st, { type: 'tool/call', seq: 1, time: 500, data: { name: 'write' } });
  assert.equal(st.steps, 1);
  assert.equal(st.lastTool, 'write');
  assert.equal(st.narration.length, 0);
});
test('无关事件返回原引用（Object.is 不变）', () => {
  const st = initState({}, 0);
  const same = applyEvent(st, { type: 'session/title', seq: 9, time: 999 });
  assert.equal(same, st);
});
test('只有 reasoning 的消息不产生旁白但刷新时间', () => {
  let st = initState({}, 0);
  st = applyEvent(st, assistantEvent(1, 1234, [{ type: 'reasoning', text: 'think' }]));
  assert.equal(st.narration.length, 0);
  assert.equal(st.lastAt, 1234);
});
test('不修改入参（纯函数）', () => {
  const st = initState({}, 0);
  const snapshot = JSON.stringify(st);
  applyEvent(st, assistantEvent(1, 100, [{ type: 'text', text: 'x' }]));
  assert.equal(JSON.stringify(st), snapshot);
});
test('超长旁白被截断', () => {
  let st = initState({}, 0);
  const long = 'a'.repeat(MAX_NARRATION_CHARS + 500);
  st = applyEvent(st, assistantEvent(1, 100, [{ type: 'text', text: long }]));
  assert.ok(st.narration[0].text.length <= MAX_NARRATION_CHARS);
  assert.ok(st.narration[0].text.endsWith('…'));
});
test(`环形缓冲上限 ${MAX_NARRATION}`, () => {
  let st = initState({}, 0);
  for (let i = 0; i < MAX_NARRATION + 30; i++) {
    st = applyEvent(st, assistantEvent(i, i, [{ type: 'text', text: `t${i}` }]));
  }
  assert.equal(st.narration.length, MAX_NARRATION);
  // 最老的被丢弃
  assert.equal(st.narration[0].text, 't30');
});
test('畸形事件不抛错', () => {
  const st = initState({}, 0);
  assert.equal(applyEvent(st, null), st);
  assert.equal(applyEvent(st, {}), st);
});

console.log('\n=== pageNarration ===');
const fakeNarration = Array.from({ length: 20 }, (_, i) => ({ seq: i, time: i, text: `n${i}` }));
test('默认取最近 limit 条', () => {
  const r = pageNarration(fakeNarration, 6, undefined);
  assert.equal(r.page.length, 6);
  assert.equal(r.page[5].text, 'n19');
  assert.equal(r.omitted, 14);
  assert.equal(r.total, 20);
  assert.equal(r.oldestSeq, 14);
});
test('before 游标往回翻', () => {
  const r = pageNarration(fakeNarration, 3, 14);
  assert.equal(r.page.length, 3);
  assert.equal(r.page[2].text, 'n13');
  assert.equal(r.oldestSeq, 11);
});
test('返回顺序是 seq 递增', () => {
  const r = pageNarration(fakeNarration, 5, undefined);
  for (let i = 1; i < r.page.length; i++) {
    assert.ok(r.page[i].seq > r.page[i - 1].seq);
  }
});
test('空数组', () => {
  const r = pageNarration([], 6, undefined);
  assert.deepEqual(r.page, []);
  assert.equal(r.total, 0);
  assert.equal(r.oldestSeq, null);
});
test('before 超过全部时返回空页', () => {
  const r = pageNarration(fakeNarration, 3, 0);
  assert.equal(r.page.length, 0);
});

console.log('\n=== clampLimit ===');
test('默认值', () => {
  assert.equal(clampLimit(undefined), DEFAULT_LIMIT);
  assert.equal(clampLimit('x'), DEFAULT_LIMIT);
});
test('夹到 1..MAX', () => {
  assert.equal(clampLimit(0), 1);
  assert.equal(clampLimit(-5), 1);
  assert.equal(clampLimit(999), MAX_LIMIT);
  assert.equal(clampLimit(6.9), 6);
});

console.log('\n=== countSince ===');
test('数出新增条数（不是 seq 差）', () => {
  // seq 不连续：0, 5, 12, 40 —— seq 差 40，但新增只有 3 条
  const narration = [
    { seq: 5 }, { seq: 12 }, { seq: 40 },
  ];
  assert.equal(countSince(narration, 0), 3);
  assert.equal(countSince(narration, 12), 1);
});
test('首次查看返回 undefined', () => {
  assert.equal(countSince([{ seq: 1 }], undefined), undefined);
});

console.log('\n=== SeenCursor ===');
test('首次读为 undefined，写过之后能读', () => {
  const c = new SeenCursor();
  assert.equal(c.read('p', 'c1'), undefined);
  c.write('p', 'c1', 42);
  assert.equal(c.read('p', 'c1'), 42);
});
test('不同子代理互不干扰（多子代理并发关键项）', () => {
  const c = new SeenCursor();
  c.write('p', 'a', 10);
  c.write('p', 'b', 99);
  assert.equal(c.read('p', 'a'), 10);
  assert.equal(c.read('p', 'b'), 99);
});
test('不同父代理看同一子代理互不干扰', () => {
  const c = new SeenCursor();
  c.write('p1', 'x', 5);
  c.write('p2', 'x', 77);
  assert.equal(c.read('p1', 'x'), 5);
  assert.equal(c.read('p2', 'x'), 77);
});

console.log('\n=== classifyState ===');
const fakeCtxRunning = { agents: { get: () => ({ status: 'running' }) } };
const fakeCtxIdle = { agents: { get: () => ({ status: 'idle' }) } };
const fakeCtxGone = { agents: { get: () => undefined } };
test('running 优先', () => {
  const r = classifyState(fakeCtxRunning, 'id', 1000, 10_000_000, 120_000);
  assert.equal(r.state, 'running');
});
test('短期空闲是 idle', () => {
  const r = classifyState(fakeCtxIdle, 'id', 1_000_000, 1_060_000, 120_000);
  assert.equal(r.state, 'idle');
  assert.equal(r.idleSeconds, 60);
});
test('长期无活动是 possibly-stuck', () => {
  const r = classifyState(fakeCtxIdle, 'id', 1_000_000, 1_900_000, 120_000);
  assert.equal(r.state, 'possibly-stuck');
  assert.equal(r.idleSeconds, 900);
});
test('无活动记录时不臆断为卡住', () => {
  const r = classifyState(fakeCtxGone, 'id', 0, 10_000_000, 120_000);
  assert.equal(r.state, 'idle');
  assert.equal(r.idleSeconds, null);
});
test('agents.get 抛错不崩', () => {
  const bad = { agents: { get: () => { throw new Error('boom'); } } };
  const r = classifyState(bad, 'id', 1000, 2000, 120_000);
  assert.equal(r.state, 'idle');
});

console.log('\n=== extractSettlement（子代理结算消息）===');

function splicedEvent(inserted) {
  return { type: 'agent/inbox/spliced', seq: 1, time: 5000, data: { target: 'next-step', start: 0, inserted } };
}

test('从标准结算通知里取出收尾语', () => {
  const msg = {
    content: [
      { type: 'text', text: 'Background subagent abc finished and will do no further work.' },
      { type: 'text', text: 'Its closing message:' },
      { type: 'text', text: '英语完成，共 60 题。' },
    ],
    source: { kind: 'subagent-settled', form: 'notice', senderSessionId: 'abc-123' },
    role: 'user',
  };
  const r = extractSettlement(msg);
  assert.equal(r.childId, 'abc-123');
  assert.equal(r.text, '英语完成，共 60 题。');
});
test('中文标记"它的收尾消息"也能识别', () => {
  const msg = {
    content: [{ type: 'text', text: '它的收尾消息:' }, { type: 'text', text: '做完了' }],
    source: { kind: 'subagent-settled', senderSessionId: 'x' },
  };
  assert.equal(extractSettlement(msg).text, '做完了');
});
test('没有收尾语时退回 summary', () => {
  const msg = {
    content: [{ type: 'text', text: 'Background subagent abc stopped.' }],
    source: { kind: 'subagent-settled', senderSessionId: 'abc', summary: 'stopped early' },
  };
  assert.equal(extractSettlement(msg).text, 'stopped early');
});
test('非结算消息返回 undefined', () => {
  assert.equal(extractSettlement({ content: [], source: { kind: 'user' } }), undefined);
  assert.equal(extractSettlement({ content: [] }), undefined);
  assert.equal(extractSettlement(null), undefined);
  assert.equal(extractSettlement({}), undefined);
});
test('缺 senderSessionId 返回 undefined', () => {
  assert.equal(extractSettlement({
    content: [{ type: 'text', text: 'x' }],
    source: { kind: 'subagent-settled' },
  }), undefined);
});
test('超长收尾语被截断', () => {
  const msg = {
    content: [{ type: 'text', text: 'Its closing message:' }, { type: 'text', text: 'x'.repeat(500) }],
    source: { kind: 'subagent-settled', senderSessionId: 'a' },
  };
  const r = extractSettlement(msg);
  assert.ok(r.text.length <= 300, `实际 ${r.text.length}`);
  assert.ok(r.text.endsWith('…'));
});

console.log('\n=== settled 累积 ===');
test('initState 带空 settled', () => {
  assert.deepEqual(initState({}, 0).settled, []);
});
test('spliced 事件累积 settled', () => {
  let st = initState({}, 0);
  st = applyEvent(st, splicedEvent([{
    content: [{ type: 'text', text: 'Its closing message:' }, { type: 'text', text: '完成 A' }],
    source: { kind: 'subagent-settled', senderSessionId: 'child-a' },
  }]));
  assert.equal(st.settled.length, 1);
  assert.equal(st.settled[0].childId, 'child-a');
  assert.equal(st.settled[0].text, '完成 A');
  assert.equal(st.settled[0].time, 5000);
});
test('同一子代理只保留最新一条', () => {
  let st = initState({}, 0);
  const mk = (txt) => splicedEvent([{
    content: [{ type: 'text', text: 'Its closing message:' }, { type: 'text', text: txt }],
    source: { kind: 'subagent-settled', senderSessionId: 'same' },
  }]);
  st = applyEvent(st, mk('第一次'));
  st = applyEvent(st, mk('第二次'));
  assert.equal(st.settled.length, 1);
  assert.equal(st.settled[0].text, '第二次');
});
test(`settled 上限 ${MAX_SETTLED}`, () => {
  let st = initState({}, 0);
  for (let i = 0; i < MAX_SETTLED + 10; i++) {
    st = applyEvent(st, splicedEvent([{
      content: [{ type: 'text', text: 'Its closing message:' }, { type: 'text', text: `c${i}` }],
      source: { kind: 'subagent-settled', senderSessionId: `child-${i}` },
    }]));
  }
  assert.equal(st.settled.length, MAX_SETTLED);
});
test('无结算内容的 spliced 事件返回原引用', () => {
  const st = initState({}, 0);
  const same = applyEvent(st, splicedEvent([{ content: [], source: { kind: 'user' } }]));
  assert.equal(same, st);
});
test('inserted 非数组时不崩', () => {
  const st = initState({}, 0);
  assert.equal(applyEvent(st, { type: 'agent/inbox/spliced', seq: 1, time: 1, data: {} }), st);
});

// ---------------------------------------------------------------
// stopReason：从 turn/end 折叠终止原因
// ---------------------------------------------------------------

/** 造一个 turn/end 事件。 */
function turnEndEvent(reason, seq = 10, time = 1000) {
  return { type: 'turn/end', seq, time, data: { turn: 1, reason } };
}

test('initState 初始没有 stopReason', () => {
  assert.equal(initState({}, 0).stopReason, undefined);
});

test('completed 被记录', () => {
  const st = applyEvent(initState({}, 0), turnEndEvent({ kind: 'completed' }));
  assert.deepEqual(st.stopReason, { kind: 'completed' });
});

test('max-tokens 被记录 —— 这是被截断的信号', () => {
  const st = applyEvent(initState({}, 0), turnEndEvent({ kind: 'max-tokens' }));
  assert.equal(st.stopReason.kind, 'max-tokens');
});

test('error 带 message 和 code', () => {
  const st = applyEvent(initState({}, 0), turnEndEvent({
    kind: 'error',
    error: { message: 'transport error: fetch failed', code: 'TRANSPORT' },
  }));
  assert.equal(st.stopReason.kind, 'error');
  assert.equal(st.stopReason.message, 'transport error: fetch failed');
  assert.equal(st.stopReason.code, 'TRANSPORT');
});

test('aborted 的嵌套 reason 折成 via', () => {
  const st = applyEvent(initState({}, 0), turnEndEvent({
    kind: 'aborted',
    reason: { kind: 'user' },
  }));
  assert.equal(st.stopReason.kind, 'aborted');
  assert.equal(st.stopReason.via, 'user');
});

test('超长 error.message 被截断', () => {
  const st = applyEvent(initState({}, 0), turnEndEvent({
    kind: 'error',
    error: { message: 'x'.repeat(5000) },
  }));
  assert.ok(st.stopReason.message.length <= 240, `got ${st.stopReason.message.length}`);
  assert.ok(st.stopReason.message.endsWith('…'));
});

test('reason 缺失时 turn/end 仍然刷新 lastAt', () => {
  const st = applyEvent(initState({}, 0), turnEndEvent(undefined, 5, 777));
  assert.equal(st.lastAt, 777);
  assert.equal(st.lastSeq, 5);
  assert.equal(st.stopReason, undefined);
});

test('reason.kind 不是字符串时不记录', () => {
  const st = applyEvent(initState({}, 0), turnEndEvent({ kind: 42 }));
  assert.equal(st.stopReason, undefined);
});

test('多个 turn/end 时后者覆盖前者', () => {
  let st = applyEvent(initState({}, 0), turnEndEvent({ kind: 'interrupted' }, 1, 100));
  st = applyEvent(st, turnEndEvent({ kind: 'completed' }, 2, 200));
  assert.equal(st.stopReason.kind, 'completed');
});

test('extractStopReason 对非对象返回 undefined', () => {
  assert.equal(extractStopReason(null), undefined);
  assert.equal(extractStopReason('completed'), undefined);
  assert.equal(extractStopReason(undefined), undefined);
});

test('turn/end 不改 narration —— 终止不产生旁白', () => {
  let st = applyEvent(initState({}, 0), {
    type: 'assistant/message', seq: 1, time: 10,
    data: { message: { content: [{ type: 'text', text: '干活中' }] } },
  });
  const before = st.narration.length;
  st = applyEvent(st, turnEndEvent({ kind: 'max-tokens' }, 2, 20));
  assert.equal(st.narration.length, before);
});

// ---------------------------------------------------------------
// buildRow 空值防御 —— 投影状态读不到时绝不能抛
//
// 这组测试针对一个真实缺陷：readProgress 只挡 undefined，挡不住
// stateOf 返回 null。旧代码直接读 progress.lastAt / progress.narration，
// 抛 TypeError 会让整次工具调用失败——比少一行信息糟得多。
// ---------------------------------------------------------------

/** 造一个最小的 ctx，让 buildRow 走到读投影的分支。 */
function ctxWithProgress(progressValue, agentsStatus = 'running') {
  return {
    sessions: { get: (id) => ({ id }) },
    sessionProjections: { stateOf: () => progressValue },
    agents: { get: () => ({ status: agentsStatus }) },
  };
}

/** buildRow 的必需 options。 */
function rowOptions(extra = {}) {
  return {
    limit: 6,
    before: undefined,
    includeNarration: true,
    stuckMs: 120_000,
    now: 100_000,
    parentId: 'parent-1',
    cursor: undefined,
    ...extra,
  };
}

test('stateOf 返回 null 时不抛，降级为无进度行', () => {
  const ctx = ctxWithProgress(null);
  const row = buildRow(ctx, { id: 'child-1', label: 'x', mode: 'continuable' }, rowOptions());
  assert.equal(row.id, 'child-1');
  assert.deepEqual(row.narration, []);
  assert.equal(row.state, 'running');
});

test('stateOf 返回 undefined 时不抛', () => {
  const ctx = ctxWithProgress(undefined);
  const row = buildRow(ctx, { id: 'child-2', label: 'y', mode: 'continuable' }, rowOptions());
  assert.deepEqual(row.narration, []);
});

test('narration 是 null 时不抛（schema 要求数组）', () => {
  const ctx = ctxWithProgress({ narration: null, steps: 3, lastAt: 50_000 });
  const row = buildRow(ctx, { id: 'c', label: 'l', mode: 'continuable' }, rowOptions());
  assert.deepEqual(row.narration, []);
  assert.equal(row.narrationTotal, 0);
});

test('缺 narration 字段时不抛', () => {
  const ctx = ctxWithProgress({ steps: 3, lastAt: 50_000 });
  const row = buildRow(ctx, { id: 'c', label: 'l', mode: 'continuable' }, rowOptions());
  assert.deepEqual(row.narration, []);
});

test('narration 是字符串（被写坏）时不抛', () => {
  const ctx = ctxWithProgress({ narration: 'oops', steps: 1, lastAt: 50_000 });
  const row = buildRow(ctx, { id: 'c', label: 'l', mode: 'continuable' }, rowOptions());
  assert.deepEqual(row.narration, []);
});

test('stopReason 被透传到行', () => {
  const ctx = ctxWithProgress({
    narration: [], steps: 5, lastAt: 90_000,
    stopReason: { kind: 'max-tokens' },
  });
  const row = buildRow(ctx, { id: 'c', label: 'l', mode: 'continuable' }, rowOptions());
  assert.deepEqual(row.stopReason, { kind: 'max-tokens' });
});

test('没有 stopReason 时行里不带该字段', () => {
  const ctx = ctxWithProgress({ narration: [], steps: 5, lastAt: 90_000 });
  const row = buildRow(ctx, { id: 'c', label: 'l', mode: 'continuable' }, rowOptions());
  assert.equal(row.stopReason, undefined);
});

test('progress 为 null 时仍能正常渲出 steps 缺失的行', () => {
  const ctx = ctxWithProgress(null);
  const row = buildRow(ctx, { id: 'c', label: 'l', mode: 'continuable' }, rowOptions());
  assert.equal(row.steps, undefined);
  assert.equal(row.lastTool, undefined);
});

console.log(`\n${'-'.repeat(50)}`);
console.log(`通过 ${passed}，失败 ${failed}`);
process.exit(failed > 0 ? 1 : 0);