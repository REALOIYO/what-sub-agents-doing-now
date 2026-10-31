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
  initState,
  extractNarrationTexts,
  applyEvent,
} from '../lib/projection.js';
import { pageNarration, clampLimit, countSince, SeenCursor, DEFAULT_LIMIT, MAX_LIMIT, classifyState } from '../lib/paginate.js';

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

console.log(`\n${'-'.repeat(50)}`);
console.log(`通过 ${passed}，失败 ${failed}`);
process.exit(failed > 0 ? 1 : 0);
