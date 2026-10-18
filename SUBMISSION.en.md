# RFC: let a steering message interrupt an in-flight tool wait

**Status:** working reference implementation, ~200 lines, no core changes.
**Scope:** `dsh-agent` / `dsh-agent-loop` / `dsh-tools` interaction.

## What happens today

Steering is the only channel a user has to redirect a running agent, and it is
blind exactly when it is most needed — while the agent is blocked in a long tool
call.

Reproduction on the packaged desktop build (`0.2.1-rc.2`, Windows):

1. Start a 120 s background job.
2. Call `job_output` with `wait: true, timeout_ms: 60000`.
3. Type a message into the composer while the call is blocked.

The message is accepted, the composer shows it as steering — and the tool call
keeps waiting. The message is only read once the call returns on its own, or
once its wait timeout expires. In one run the wait was cut short only because a
background subagent happened to report back; the same call with no such event ran
to its full timeout (25 s, then 45 s, in consecutive attempts).

## Why

`next-step` inbox messages are claimed at step boundaries only. `dsh-agent-loop`
describes it as claiming the pending `next-step` input between steps, and
`dsh-agent` documents that `cancel()` aborts the whole turn — there is no
operation that keeps the turn running and aborts only the current step.

So a steer that lands mid-step cannot be observed by anything until every tool
call in that step settles. For a blocking wait that can be minutes.

## Proposed seam

A `tools/execute` policy that mirrors `dsh-tool-call-timeout-policy`: swap
`exec.signal` for a fused signal, abort it when a steering message is spliced
into `next-step`, then map the resulting failure to a model-facing result.

This needs no new core API, because:

- `tools/execute` is already the documented wrapper point for "timeouts or
  retries around dispatch", and the timeout policy shows the exact swap/restore
  idiom.
- `session/event` already carries `agent/inbox/spliced` with
  `target: 'next-step'` and the inserted messages, including their
  `source.kind`.
- `jobs.wait` already accepts the caller signal as its fourth argument and
  rejects on external abort, so the bundled background-job wait becomes
  interruptible without touching `dsh-jobs`.

## Behavior and safety

- **Cooperative, never racing.** The wrapper only notifies through
  `exec.signal`; it never abandons the tool promise. Tools that ignore the signal
  keep the caller waiting — the same documented limitation as the timeout
  policy.
- **Steering only, not queued prompts.** `followup` lands in `next-turn` and is
  deliberately ignored; a user who chose "queue" asked for the next turn.
- **Grace period.** Calls younger than `minElapsedMs` (default 250 ms) are not
  killed outright; the abort is scheduled for the end of the grace period and
  cancelled if the call finishes first. Fast tools are untouched.
- **Per-session isolation.** Only calls belonging to the session that received
  the steering message are aborted.
- **Fail-closed result.** An aborted failure is replaced with
  `isError: true`, code `TOOL_INTERRUPTED_BY_STEERING`, telling the model the
  call did not complete and its outcome is unknown. A tool that ignored the
  abort and still returned success keeps its own result.
- **No new vocabulary.** The message itself is delivered by the normal
  `next-step` claim, so the model sees the user's words in the next step.

## What it does not fix

- LLM streaming itself is not interrupted; that is turn-level cancellation.
- Tool calls that ignore `exec.signal` are unaffected.

## Field measurement

With the policy installed, a `job_output(wait, timeout 60 s)` blocked on a 120 s
job returned after **5.17 s**, at the moment a background subagent reported back,
with the structured interrupt result and the message delivered in the next step.
A 16-assertion harness (fake `ctx`, fake `tools/execute`, fake `session/event`)
covers: interruption, passthrough, non-user sources ignored, `next-turn`
ignored, signal-ignoring tools untouched, signal restore, grace period,
cross-session isolation, and default source-kind matching.

## Open questions

1. **Where should this live?** As a core policy package next to
   `dsh-tool-call-timeout-policy`, or as a community plugin? It only uses public
   seams, so it works either way.
2. **Default on or off?** On makes steering feel responsive; off keeps every
   existing completion guarantee. A middle ground is to interrupt only tools
   that declare themselves interruptible (a `ToolDefinition` flag, like
   `timeoutMs`).
3. **Should `subagent-settled` and `agent-message` count as steering here?**
   Today both are delivered through `parent.steer(...)` when the parent is
   running, so they land in `next-step` and are equally unable to wake a blocked
   wait. Treating them as interruptions makes "wait for my background child"
   responsive too. This is the default in the implementation below.
4. **Is a loop-level fix preferable?** Claiming `next-step` between tool calls
   inside a step, or treating a steer as a scheduling barrier, would be more
   principled than aborting calls. It is also a deeper change to loop semantics.
   If that direction is preferred, this policy is still a zero-risk stopgap.

## Implementation

Single file, no imports, no build step:

```js
/** Structured error code carried on every replacement result. */
export const INTERRUPTED = 'TOOL_INTERRUPTED_BY_STEERING';
export const name = 'steering-interrupt';
export const inject = ['tools'];

const DEFAULTS = {
  minElapsedMs: 250,
  sourceKinds: ['user', 'subagent-settled', 'agent-message'],
  exclude: [],
};

function fuse(signals) {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals);
  const controller = new AbortController();
  const onAbort = (event) => {
    controller.abort(event.target?.reason);
    for (const signal of signals) signal.removeEventListener('abort', onAbort);
  };
  for (const signal of signals) {
    if (signal.aborted) { controller.abort(signal.reason); break; }
    signal.addEventListener('abort', onAbort, { once: true });
  }
  return controller.signal;
}

function textOf(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  return blocks
    .filter((b) => b !== null && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text).join('\n').trim();
}

const clip = (text, limit) => text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;

function interruptedResult(entry) {
  const asked = entry.reason === undefined ? '' : ` The message was: ${JSON.stringify(clip(entry.reason, 240))}`;
  const message = `tool call "${entry.name}" was interrupted by an incoming steering message`;
  return {
    content: [{ type: 'text', text: [
      `Error: ${message}.`,
      `That call did not complete and its outcome is unknown after ${Date.now() - entry.startedAt}ms.`,
      'Verify external state before retrying it. The steering message is delivered as this step\'s input — act on it now.',
      asked.trim(),
    ].filter((line) => line !== '').join('\n') }],
    isError: true,
    error: { message, info: { name: 'ToolSteeringInterruptError', code: INTERRUPTED } },
  };
}

export function apply(ctx, config) {
  const options = { ...DEFAULTS, ...(config ?? {}) };
  const minElapsedMs = Number.isFinite(options.minElapsedMs) ? Math.max(0, options.minElapsedMs) : DEFAULTS.minElapsedMs;
  const sourceKinds = new Set(Array.isArray(options.sourceKinds) ? options.sourceKinds : DEFAULTS.sourceKinds);
  const excluded = new Set(Array.isArray(options.exclude) ? options.exclude : []);

  const inFlight = new Map();

  const track = (sessionId, entry) => {
    let entries = inFlight.get(sessionId);
    if (entries === undefined) inFlight.set(sessionId, entries = new Set());
    entries.add(entry);
    return () => { entries.delete(entry); if (entries.size === 0) inFlight.delete(sessionId); };
  };

  const abortEntry = (entry, reason) => {
    if (entry.controller.signal.aborted) return;
    entry.reason = reason;
    entry.controller.abort(new Error(reason === undefined ? INTERRUPTED : `${INTERRUPTED}: ${clip(reason, 120)}`));
  };

  const interruptSession = (sessionId, reason) => {
    const entries = inFlight.get(sessionId);
    if (entries === undefined) return 0;
    let count = 0;
    const now = Date.now();
    for (const entry of [...entries]) {
      if (entry.controller.signal.aborted) continue;
      const wait = minElapsedMs - (now - entry.startedAt);
      if (wait <= 0) { abortEntry(entry, reason); count++; continue; }
      entry.timer = setTimeout(() => {
        entry.timer = undefined;
        if (!entries.has(entry)) return;
        abortEntry(entry, reason);
      }, wait);
      entry.timer.unref?.();
      count++;
    }
    return count;
  };

  ctx.on('session/event', (session, event) => {
    if (event === null || typeof event !== 'object') return;
    if (event.type !== 'agent/inbox/spliced') return;
    const data = event.data;
    if (data === null || typeof data !== 'object' || data.target !== 'next-step') return;
    if (data.outcome === 'canceled') return;
    const inserted = Array.isArray(data.inserted) ? data.inserted : [];
    if (inserted.length === 0) return;
    const steering = inserted.find((message) => sourceKinds.has(message?.source?.kind));
    if (steering === undefined) return;
    interruptSession(session.id, textOf(steering));
  });

  ctx.on('tools/execute', async (exec, next) => {
    const sessionId = exec.agent?.session?.id;
    if (sessionId === undefined || excluded.has(exec.name)) return next();

    const controller = new AbortController();
    const entry = { name: exec.name, controller, startedAt: Date.now(), reason: undefined, timer: undefined };
    const untrack = track(sessionId, entry);
    const upstream = exec.signal;
    exec.signal = upstream === undefined ? controller.signal : fuse([upstream, controller.signal]);
    try {
      const result = await next();
      if (controller.signal.aborted && result?.isError === true) return interruptedResult(entry);
      return result;
    } catch (error) {
      if (controller.signal.aborted) return interruptedResult(entry);
      throw error;
    } finally {
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      untrack();
      exec.signal = upstream;
    }
  });
}
```

Config as a loader entry:

```yaml
- insert:
    - id: steering-interrupt
      name: '@ExboCooope/dsh-steering-interrupt'
      config:
        minElapsedMs: 250
        sourceKinds: [user, subagent-settled, agent-message]
```

If this direction is useful, I am happy to reshape it as a core package
(`dsh-tool-interrupt-on-steering`) or add the `ToolDefinition` opt-in flag — let
me know which shape fits the architecture best.

---

*Reference implementation, measurements and write-up by **DeepSeek-V4.1-Flash
1017** (AI agent), for [@ExboCooope](https://github.com/ExboCooope).
Source: <https://github.com/ExboCooope/dsh-steering-interrupt>.*
