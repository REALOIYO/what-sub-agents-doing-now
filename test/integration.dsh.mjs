/**
 * 集成验证：用模拟 ctx 跑完整 apply()，验证投影注册 + 工具注册 + execute 全链路。
 *
 * 必须在 DSH 的 Electron 运行时下跑（需要能读 app.asar 校验 schema）：
 *   "<DSH 安装目录>/DeepSeek Harness.exe" test/integration.dsh.mjs <installDir> [repoDir]
 *
 * 或设环境变量 DSH_INSTALL。
 */

import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const [, , installArg, repoArg] = process.argv;
const installDir = installArg ?? process.env.DSH_INSTALL;
if (installDir === undefined) {
  console.error(
    '缺少 DSH 安装目录。\n'
    + '  用法: "<DSH exe>" test/integration.dsh.mjs <installDir> [repoDir]\n'
    + '  或设置环境变量 DSH_INSTALL。',
  );
  process.exit(2);
}
const repoDir = repoArg ?? resolvePath(dirname(fileURLToPath(import.meta.url)), '..');
const asarBase = `${installDir.replace(/[/\\]$/, '')}/resources/app.asar/dsh/node_modules/@deepseek-ai`;

const m = await import(pathToFileURL(`${repoDir}/lib/index.js`).href);

let failures = 0;
function ok(label, cond, extra) {
  if (cond) console.log('✓', label);
  else { failures++; console.log('✗', label, extra ?? ''); }
}

// --- 1) 基础 apply ---
let def;
let proj;
const warnings = [];
const ctx = {
  logger: { warn: (msg) => warnings.push(msg), info: () => {} },
  tools: { register: (d) => { def = d; } },
  sessionProjections: { register: (p) => { proj = p; return () => {}; } },
  sessions: { get: () => undefined },
  agents: { get: () => undefined },
  subagents: { listChildren: async () => [] },
};
m.apply(ctx, {});

ok('apply 注册工具', !!def);
ok('apply 注册投影', !!proj);
ok('无注册告警', warnings.length === 0, warnings);
ok('工具名', def?.name === 'what_subagents_are_doing', def?.name);
ok('投影 key', proj?.key === 'whatsubagentsdoingnow', proj?.key);
ok('stateVersion 是非负整数', Number.isInteger(proj?.stateVersion) && proj.stateVersion >= 0);
ok('host-only（无 wire）', proj?.wire === undefined);
ok('inject 齐全', JSON.stringify(m.inject) === JSON.stringify(['tools','subagents','agents','sessions','sessionProjections']));

// --- 2) 投影链路：init + apply ---
let st = proj.init({ id: 'x' }, 0);
st = proj.apply(st, {
  type: 'assistant/message', seq: 1, time: 1000,
  data: { message: { content: [
    { type: 'reasoning', text: 'SECRET_REASONING' },
    { type: 'text', text: '我正在做数学卷' },
  ] } },
});
ok('投影累积旁白', st.narration.length === 1, JSON.stringify(st.narration));
ok('reasoning 被排除', !JSON.stringify(st).includes('SECRET_REASONING'));
st = proj.apply(st, { type: 'tool/call', seq: 2, time: 2000, data: { name: 'write' } });
ok('tool/call 计步', st.steps === 1 && st.lastTool === 'write');

// --- 3) execute 链路 ---
let tool2;
const ctx2 = {
  ...ctx,
  tools: { register: (d) => { tool2 = d; } },
  subagents: {
    listChildren: async () => [
      { id: 'child-a', label: '做数学卷', mode: 'continuable' },
      { id: 'child-b', label: '外部任务', mode: 'external' },
      { id: 'child-c', label: '一次性', mode: 'once' },
    ],
  },
  sessions: { get: (id) => (id === 'child-a' ? { id } : undefined) },
  sessionProjections: {
    register: () => () => {},
    stateOf: (session, key) => (session.id === 'child-a' ? {
      narration: [
        { seq: 10, time: 1000, text: '第一条' },
        { seq: 20, time: 2000, text: '第二条' },
        { seq: 30, time: 3000, text: '第三条' },
      ],
      lastTool: 'write', steps: 5, lastAt: Date.now() - 5000, lastSeq: 30,
    } : undefined),
  },
  agents: { get: () => ({ status: 'running' }) },
};
m.apply(ctx2, {});
const rows = await tool2.execute({ limit: 2 }, { agent: { id: 'parent-1' } });

ok('返回 2 行（一次性被过滤）', rows.length === 2, `got ${rows.length}`);
ok('continuable 行有旁白', Array.isArray(rows[0].narration) && rows[0].narration.length === 2);
ok('分页正确：取最近 2 条', rows[0].narration[1].text === '第三条', JSON.stringify(rows[0].narration));
ok('omitted 计数', rows[0].narrationOmitted === 1, String(rows[0].narrationOmitted));
ok('total 计数', rows[0].narrationTotal === 3);
ok('external 行标注', rows[1].state === 'external', rows[1]?.state);
ok('external 附说明', typeof rows[1].note === 'string');

// --- 4) 渲染 ---
const rendered = tool2.output.render({ limit: 2 }, rows)[0].text;
ok('渲染含状态', rendered.includes('[running]'), rendered);
ok('渲染含旁白', rendered.includes('第三条'));
ok('渲染含分页提示', rendered.includes('before='), rendered);

// --- 5) 二次查看的增量 ---
const rows2 = await tool2.execute({ limit: 2 }, { agent: { id: 'parent-1' } });
ok('第二次有 sinceLastLook', rows2[0].narrationSinceLastLook === 0, String(rows2[0].narrationSinceLastLook));

// --- 6) 失败必须显式抛错，不能返回空数组 ---
let threw = false;
const ctx3 = {
  ...ctx,
  tools: { register: (d) => { tool2 = d; } },
  subagents: { listChildren: async () => { const e = new Error('query down'); e.code = 'SUBAGENT_CONTROL_QUERY_UNAVAILABLE'; throw e; } },
};
m.apply(ctx3, {});
try { await tool2.execute({}, { agent: { id: 'p' } }); }
catch (e) { threw = e.message.includes('could not read'); }
ok('catalog 失败时显式抛错', threw);

// --- 7) 无 exec.agent 必须抛错 ---
const ctx4 = { ...ctx, tools: { register: (d) => { tool2 = d; } } };
m.apply(ctx4, {});
let threw2 = false;
try { await tool2.execute({}, {}); } catch { threw2 = true; }
ok('缺少 exec.agent 时抛错', threw2);

// --- 8) 回归：子代理结束、session 卸载后 narration 必须是数组不是 null ---
// 实测踩过：子代理跑完 session 被卸载 -> readProgress 返回 undefined
// -> 旧实现给 narration=null -> DSH 输出校验拒绝
//    "value[0].narration must be an array"，整个工具调用失败。
const toolsApi = await import(pathToFileURL(`${asarBase}/dsh-tools/lib/index.js`).href);

const ctxGone = {
  ...ctx,
  tools: { register: (d) => { tool2 = d; } },
  subagents: { listChildren: async () => [{ id: 'gone-1', label: '已结束的子代理', mode: 'continuable' }] },
  sessions: { get: () => undefined },              // session 已卸载
  sessionProjections: { register: () => () => {}, stateOf: () => undefined },
  agents: { get: () => undefined },
};
m.apply(ctxGone, {});
const rowsGone = await tool2.execute({ limit: 6 }, { agent: { id: 'p' } });
ok('session 卸载后仍返回一行', rowsGone.length === 1);
ok('narration 是数组', Array.isArray(rowsGone[0].narration), JSON.stringify(rowsGone[0].narration));
ok('narration 为空数组', rowsGone[0].narration.length === 0);
ok('附有说明 note', typeof rowsGone[0].note === 'string' && rowsGone[0].note.includes('unavailable'));

// 关键：用 DSH 真实校验器验证输出合法
const viol = toolsApi.validateJsonSchemaValue(def.output.schema, rowsGone, '');
ok('输出通过 DSH schema 校验', viol.length === 0, JSON.stringify(viol));

// 渲染也要能跑
let renderOk = true;
try { tool2.output.render({}, rowsGone); } catch { renderOk = false; }
ok('卸载态可正常渲染', renderOk);

console.log('\n总体:', failures === 0 ? 'ALL OK' : `${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
