/**
 * 用 DSH 真实的 schema 校验器验证本插件的三处 schema。
 *
 * 这是最关键的一道保险：DSH 的 assertSupportedJsonSchema 只接受
 * type/oneOf/properties/required/additionalProperties/items/enum/const
 * + 注解，用错关键字（比如 maxItems）会在注册时直接抛错，
 * 让插件在真实 profile 里加载失败。
 *
 * 必须在 DSH 的 Electron 运行时下跑（能读 app.asar）：
 *   "<DSH 安装目录>/DeepSeek Harness.exe" test/schema.dsh.mjs <installDir> [repoDir]
 *
 * 或设环境变量 DSH_INSTALL 指向安装目录。
 */

import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

/** 从 argv 或环境变量解析安装目录与仓库目录。 */
function resolveDirs() {
  const [, , installArg, repoArg] = process.argv;
  const installDir = installArg ?? process.env.DSH_INSTALL;
  if (installDir === undefined) {
    console.error(
      '缺少 DSH 安装目录。\n'
      + '  用法: "<DSH exe>" test/schema.dsh.mjs <installDir> [repoDir]\n'
      + '  或设置环境变量 DSH_INSTALL。\n'
      + '  installDir 需包含 resources/app.asar。',
    );
    process.exit(2);
  }
  // 仓库根：本脚本在 test/ 下，回推一级
  const repoDir = repoArg ?? resolvePath(dirname(fileURLToPath(import.meta.url)), '..');
  return { installDir, repoDir };
}

const { installDir, repoDir } = resolveDirs();
const asarBase = `${installDir.replace(/[/\\]$/, '')}/resources/app.asar/dsh/node_modules/@deepseek-ai`;

const tools = await import(pathToFileURL(`${asarBase}/dsh-tools/lib/index.js`).href);
const m = await import(pathToFileURL(`${repoDir}/lib/index.js`).href);
const { STATE_SCHEMA } = await import(pathToFileURL(`${repoDir}/lib/projection-registry.js`).href);

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
  ['narration 空数组', [{ id: 'c', label: 'L', mode: 'continuable', state: 'idle', narration: [] }], 0],
  ['narration 为 null（应被拒）', [{ id: 'c', label: 'L', mode: 'continuable', state: 'idle', narration: null }], 1],
];
for (const [label, rows, expect] of outCases) {
  const got = tools.validateJsonSchemaValue(def.output.schema, rows, '');
  const ok = expect === 0 ? got.length === 0 : got.length > 0;
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(got).slice(0, 100)}`);
}

console.log('\n总体:', failures === 0 ? 'ALL OK' : `${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
