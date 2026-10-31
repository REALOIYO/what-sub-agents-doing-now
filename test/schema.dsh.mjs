/**
 * 用 DSH 真实的 schema 校验器验证本插件的三处 schema。
 *
 * 这是最关键的一道保险：DSH 的 assertSupportedJsonSchema 只接受
 * type/oneOf/properties/required/additionalProperties/items/enum/const
 * + 注解，用错关键字（比如 maxItems）会在注册时直接抛错，
 * 让插件在真实 profile 里加载失败。
 *
 * 必须在 DSH 的 Electron 运行时下跑（能读 app.asar）：
 *   "F:/dsh/DeepSeek Harness.exe" test/schema.dsh.mjs
 */

const B = 'F:/dsh/resources/app.asar/dsh/node_modules/@deepseek-ai';
const tools = await import(`file:///${B}/dsh-tools/lib/index.js`);
const m = await import('file:///F:/DSH_workspace_main_dsh/whatsubagentsdoingnow/lib/index.js');
const { STATE_SCHEMA } = await import('file:///F:/DSH_workspace_main_dsh/whatsubagentsdoingnow/lib/projection-registry.js');

let def;
const ctx = {
  logger: { warn: () => {}, info: () => {} },
  tools: { register: (d) => { def = d; } },
  sessionProjections: { register: () => () => {} },
  sessions: { get: () => undefined },
  agents: { get: () => undefined },
  subagents: { listChildren: async () => [] },
};
m.apply(ctx, {});

let failures = 0;
function check(label, fn) {
  try { fn(); console.log('✓', label); }
  catch (e) { failures++; console.log('✗', label + ':', e.message); }
}

console.log('=== schema 关键字子集 ===');
check('parameters schema', () => tools.assertSupportedJsonSchema(def.parameters));
check('output schema', () => tools.assertSupportedJsonSchema(def.output.schema));
check('projection stateSchema', () => tools.assertSupportedJsonSchema(STATE_SCHEMA));

console.log('\n=== 参数校验（validateJsonSchemaValue 返回 violations 数组）===');
const v = (args) => tools.validateJsonSchemaValue(def.parameters, args, '');

const cases = [
  ['合法参数', { limit: 5, scope: 'children', includeNarration: true }, 0],
  ['空参数（全部可选）', {}, 0],
  ['非法 scope', { scope: 'bogus' }, 1],
  ['非法 limit 类型', { limit: 'x' }, 1],
  ['未知字段', { unknown: 1 }, 1],
];
for (const [label, args, expectViolations] of cases) {
  const got = v(args);
  const ok = expectViolations === 0 ? got.length === 0 : got.length > 0;
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(got).slice(0, 100)}`);
}

console.log('\n=== 输出 schema 校验 ===');
const outCases = [
  ['合法行', [{ id: 'c', label: 'L', mode: 'continuable', state: 'running' }], 0],
  ['缺必填 state', [{ id: 'c', label: 'L', mode: 'continuable' }], 1],
  ['多余字段', [{ id: 'c', label: 'L', mode: 'continuable', state: 'idle', bogus: 1 }], 1],
];
for (const [label, rows, expect] of outCases) {
  const got = tools.validateJsonSchemaValue(def.output.schema, rows, '');
  const ok = expect === 0 ? got.length === 0 : got.length > 0;
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(got).slice(0, 100)}`);
}

console.log('\n总体:', failures === 0 ? 'ALL OK' : `${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
