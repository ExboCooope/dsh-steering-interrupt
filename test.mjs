// Unit harness: fake the two Cordis seams the plugin uses and assert behavior.
import { apply, INTERRUPTED } from './index.js';

const session = { id: 'session-1' };
const agent = { id: 'agent-1', session };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Build a fake ctx that records the plugin's listeners. */
function fakeCtx() {
  const map = new Map();
  const ctx = {
    on(event, fn) {
      if (!map.has(event)) map.set(event, []);
      map.get(event).push(fn);
      return () => {};
    },
    logger: { debug() {} },
  };
  return { ctx, map };
}

/** Run one dispatch through the plugin wrapper; `body` receives exec.signal. */
function pipeline(map, exec, body) {
  const handler = map.get('tools/execute')[0];
  return handler(exec, () => body(exec.signal));
}

function steer(map, text, kind = 'user', target = 'next-step') {
  for (const fn of map.get('session/event') ?? []) {
    fn(session, {
      type: 'agent/inbox/spliced',
      data: { target, start: 0, inserted: [{ id: 'm', source: { kind }, content: text === undefined ? [] : [{ type: 'text', text }] }] },
    });
  }
}

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) console.log(`  PASS  ${label}`);
  else { failures++; console.log(`  FAIL  ${label} ${detail}`); }
}

/** A tool body that waits until its signal aborts (models jobs.wait). */
function honorsSignal(execSignal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 5000);
    execSignal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('wait aborted')); }, { once: true });
  });
}

const { ctx, map } = fakeCtx();
apply(ctx, { minElapsedMs: 0, sourceKinds: ['user', 'subagent'] });
const signal = () => new AbortController().signal;

// 1. A wait that honors the signal is cut short by a user interjection.
{
  const started = Date.now();
  const pending = pipeline(map, { name: 'job_output', agent, signal: signal() }, async (s) => {
    await honorsSignal(s);
    return { content: [{ type: 'text', text: 'job finished' }] };
  });
  await sleep(20);
  steer(map, '123');
  const result = await pending;
  const elapsed = Date.now() - started;
  check('interjection ends the wait early', elapsed < 1000, `(took ${elapsed}ms)`);
  check('replacement result is an error', result.isError === true);
  check('replacement carries the plugin code', result.error?.info?.code === INTERRUPTED, JSON.stringify(result.error));
  check('replacement names the tool', result.content[0].text.includes('job_output'));
  check('replacement echoes the message', result.content[0].text.includes('123'));
}

// 2. Without an interjection the tool result passes through untouched.
{
  const result = await pipeline(map, { name: 'read', agent, signal: signal() }, async () => ({
    content: [{ type: 'text', text: 'file body' }],
  }));
  check('passthrough when nobody interjects', result.content[0].text === 'file body' && result.isError !== true);
}

// 3. A non-interjection source does not abort.
{
  const pending = pipeline(map, { name: 'job_output', agent, signal: signal() }, async () => {
    await sleep(300);
    return { content: [{ type: 'text', text: 'done' }] };
  });
  steer(map, 'plugin context', 'runtime-context');
  const result = await pending;
  check('ignores non-user sources', result.content[0].text === 'done');
}

// 4. A queued next-turn message does not abort a step.
{
  const pending = pipeline(map, { name: 'job_output', agent, signal: signal() }, async () => {
    await sleep(200);
    return { content: [{ type: 'text', text: 'done' }] };
  });
  steer(map, 'later', 'user', 'next-turn');
  const result = await pending;
  check('queued next-turn does not abort', result.content[0].text === 'done');
}

// 5. A tool that ignores the signal keeps its own successful result.
{
  const pending = pipeline(map, { name: 'write', agent, signal: signal() }, async () => {
    await sleep(150);
    return { content: [{ type: 'text', text: 'written' }] };
  });
  await sleep(10);
  steer(map, 'stop');
  const result = await pending;
  check('signal-ignoring tool keeps its result', result.content[0].text === 'written');
}

// 6. An aborted-but-failed result is upgraded; the upstream signal still restores.
{
  const exec = { name: 'job_output', agent, signal: signal() };
  const upstream = exec.signal;
  const pending = pipeline(map, exec, async (s) => {
    await honorsSignal(s);
    return { content: [{ type: 'text', text: 'never' }], isError: true };
  });
  await sleep(20);
  steer(map, 'go');
  const result = await pending;
  check('upgrades an aborted error result', result.error?.info?.code === INTERRUPTED);
  check('restores the caller signal', exec.signal === upstream);
}

// 7. The grace period defers the abort instead of skipping it.
{
  const { ctx: ctx2, map: map2 } = fakeCtx();
  apply(ctx2, { minElapsedMs: 300, sourceKinds: ['user'] });
  const started = Date.now();
  const pending = pipeline(map2, { name: 'job_output', agent, signal: signal() }, async (s) => {
    await honorsSignal(s);
    return { content: [{ type: 'text', text: 'late' }] };
  });
  await sleep(20);
  steer(map2, 'go');
  const result = await pending;
  const elapsed = Date.now() - started;
  check('grace period still interrupts', result.isError === true, `(${elapsed}ms)`);
  check('grace period respected', elapsed >= 290 && elapsed < 1500, `(${elapsed}ms)`);
}

// 8. Calls in another session are untouched.
{
  const other = { id: 'session-2' };
  let settled = false;
  const pending = pipeline(map, { name: 'job_output', agent: { id: 'a2', session: other }, signal: signal() }, async () => {
    await sleep(200);
    return { content: [{ type: 'text', text: 'other' }] };
  }).finally(() => { settled = true; });
  steer(map, 'for session one');
  await sleep(80);
  const finishedEarly = settled;
  await pending;
  check('other sessions keep waiting', finishedEarly === false);
}

// 9. Defaults: a settled background child interrupts a wait, plugin context does not.
{
  const { ctx: ctx3, map: map3 } = fakeCtx();
  apply(ctx3);
  let settled = false;
  const pending = pipeline(map3, { name: 'job_output', agent, signal: signal() }, async (s) => {
    await honorsSignal(s);
    return { content: [{ type: 'text', text: 'never' }] };
  }).finally(() => { settled = true; });
  await sleep(300);
  steer(map3, 'a child finished', 'runtime-context');
  await sleep(40);
  const settledByContext = settled;
  steer(map3, 'Background subagent x finished.', 'subagent-settled');
  const result = await pending;
  check('defaults ignore plugin context', settledByContext === false);
  check('defaults interrupt on subagent settlement', result.error?.info?.code === INTERRUPTED, JSON.stringify(result));
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
