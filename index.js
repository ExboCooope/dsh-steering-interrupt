/**
 * Steering-interrupt: let a mid-turn interjection cut tool waits short.
 *
 * The agent loop claims `next-step` inbox messages only at step boundaries, so
 * a steering message that arrives while a tool call is still waiting sits
 * queued until that call finishes on its own. This plugin closes that gap: when
 * a steering message is spliced into `next-step`, it aborts the cancellation
 * signal of every tool call that has been in flight for longer than
 * `minElapsedMs` in that same session.
 *
 * Cancellation is cooperative, exactly like `dsh-tool-call-timeout-policy`: the
 * plugin only notifies through `exec.signal` and never races or abandons the
 * tool promise. Tools that honor the signal return early (the bundled job wait
 * is one: `jobs.wait` rejects with "wait aborted"), the step then ends, and the
 * loop claims the steering message at the next boundary. Tools that ignore the
 * signal keep the caller waiting, as they do for a timeout.
 *
 * @module @local/dsh-steering-interrupt
 */

/** Structured error code carried on every replacement result. */
export const INTERRUPTED = 'TOOL_INTERRUPTED_BY_STEERING';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'steering-interrupt';

/** The tool registry whose dispatch this plugin wraps. */
export const inject = ['tools'];

const DEFAULTS = {
  /** Abort calls that have already been waiting at least this long. */
  minElapsedMs: 250,
  /**
   * Message source kinds that count as an interjection:
   * - `user`               a human typed while the agent was running (steering)
   * - `subagent-settled`   a background child finished and reported back
   * - `agent-message`      a child or adjacent agent sent a message
   */
  sourceKinds: ['user', 'subagent-settled', 'agent-message'],
  /** Tool names never interrupted; `'*'` would interrupt everything. */
  exclude: [],
};

/** Fuse several signals into one without depending on `AbortSignal.any`. */
function fuse(signals) {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals);
  const controller = new AbortController();
  const onAbort = (event) => {
    controller.abort(event.target?.reason);
    for (const signal of signals) signal.removeEventListener('abort', onAbort);
  };
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }
  return controller.signal;
}

/** The plain text of a user-role message. */
function textOf(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  return blocks
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function clip(text, limit) {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** The model-facing replacement result for one interrupted call. */
function interruptedResult(entry) {
  const asked = entry.reason === undefined ? '' : ` The message was: ${JSON.stringify(clip(entry.reason, 240))}`;
  const message = `tool call "${entry.name}" was interrupted by an incoming steering message`;
  return {
    content: [{
      type: 'text',
      text: [
        `Error: ${message}.`,
        `That call did not complete and its outcome is unknown${entry.startedAt === undefined ? '' : ` after ${Date.now() - entry.startedAt}ms`}.`,
        'Verify external state before retrying it. The steering message is delivered as this step\'s input — act on it now.',
        asked.trim(),
      ].filter((line) => line !== '').join('\n'),
    }],
    isError: true,
    error: {
      message,
      info: { name: 'ToolSteeringInterruptError', code: INTERRUPTED },
    },
  };
}

/**
 * Track in-flight calls per session and abort them when steering arrives.
 * @param ctx - the owning Cordis context.
 * @param config - optional overrides for the defaults above.
 */
export function apply(ctx, config) {
  const options = { ...DEFAULTS, ...(config ?? {}) };
  const minElapsedMs = Number.isFinite(options.minElapsedMs) ? Math.max(0, options.minElapsedMs) : DEFAULTS.minElapsedMs;
  const sourceKinds = new Set(Array.isArray(options.sourceKinds) ? options.sourceKinds : DEFAULTS.sourceKinds);
  const excluded = new Set(Array.isArray(options.exclude) ? options.exclude : []);

  /** session id -> set of in-flight entries */
  const inFlight = new Map();

  const track = (sessionId, entry) => {
    let entries = inFlight.get(sessionId);
    if (entries === undefined) inFlight.set(sessionId, entries = new Set());
    entries.add(entry);
    return () => {
      entries.delete(entry);
      if (entries.size === 0) inFlight.delete(sessionId);
    };
  };

  const abortEntry = (entry, reason) => {
    if (entry.controller.signal.aborted) return;
    entry.reason = reason;
    entry.controller.abort(new Error(reason === undefined ? INTERRUPTED : `${INTERRUPTED}: ${clip(reason, 120)}`));
  };

  /** Interrupt every qualifying call in one session. */
  const interruptSession = (sessionId, reason) => {
    const entries = inFlight.get(sessionId);
    if (entries === undefined) return 0;
    let count = 0;
    const now = Date.now();
    for (const entry of [...entries]) {
      if (entry.controller.signal.aborted) continue;
      const wait = minElapsedMs - (now - entry.startedAt);
      if (wait <= 0) {
        abortEntry(entry, reason);
        count++;
        continue;
      }
      // The call is still young: give it the grace period, then abort if it is
      // still running. A call that finishes first clears its own timer.
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
    const count = interruptSession(session.id, textOf(steering));
    if (count > 0) {
      ctx.logger?.debug?.(`steering-interrupt: interrupting ${count} waiting tool call(s) in ${session.id}`);
    }
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
      // A tool that ignored the abort and still produced its own successful
      // result is left alone: it finished, and the steering message is claimed
      // at the next boundary anyway. Only an aborted *failure* is upgraded to
      // the clearer steering-interrupt result.
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
