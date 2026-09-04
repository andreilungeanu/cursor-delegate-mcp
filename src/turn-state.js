// Everything describing the turn in progress, in one object because it has to be wiped as one:
// session/load replays the previous turn as ordinary update frames, so anything left behind
// leaks into the next result. Fields are declared in exactly one place, freshFields(), which is
// also what reset() applies — a field added there is reset for free, and one that is missed is a
// silent stale-data bug on resume.

const isTerminalToolStatus = (status) =>
  status === "completed" || status === "failed" || status === "cancelled";

// Each stream reports its newest complete sentence, at most one per throttle window.
// Capital-letter boundary: cursor-agent thoughts arrive as sentences with no separator.
const SENTENCE_END = /[.!?](?=\s|[A-Z])|\n/;
const MARKDOWN_LINE = /^(?:[|#>`~*_=+-]|\d+[.)]\s)/;
/**
 * @param {string} prefix
 * @param {((message: string) => void) | undefined} onProgress
 * @param {number} throttleMs
 */
function progressStream(prefix, onProgress, throttleMs) {
  let buf = "", pending = null, lastEmit = 0;
  const flush = (force) => {
    if (pending === null || (!force && Date.now() - lastEmit < throttleMs)) return;
    lastEmit = Date.now();
    try { onProgress?.(prefix + pending); } catch {}
    pending = null;
  };
  const take = (s) => {
    const line = s.replace(/\s+/g, " ").trim().slice(0, 200);
    if (line.length > 3 && !MARKDOWN_LINE.test(line)) pending = line;
    flush(false);
  };
  return {
    push(text) {
      buf += text;
      for (let m; (m = SENTENCE_END.exec(buf)); buf = buf.slice(m.index + 1)) {
        take(buf.slice(0, m.index + 1));
      }
      if (buf.length > 300) { take(buf); buf = ""; }
    },
    end() { take(buf); buf = ""; flush(true); },
    reset() { buf = ""; pending = null; },
  };
}

// The single declaration of what a turn accumulates.
function freshFields() {
  return {
    resultChunks: [],
    // Text superseded by a later tool call is normally a preamble ("Inspecting the
    // implementation."), but the rule cannot tell a preamble from the whole answer: an agent
    // that replies and then runs one more command has its entire reply discarded, leaving the
    // caller "" with stopReason end_turn and no error. Kept so it can be handed back when
    // nothing survived — labelled, never blended with a real final message.
    discardedResult: "",
    sawToolCall: false,
    collectingPostToolResult: false,
    activeToolCalls: new Set(),
    // Ids observed terminal, so a stale non-terminal re-send for one is recognized and dropped
    // instead of restarting collection — which would demote an already-collected final message
    // to discardedResult and mislabel it pre-tool-fallback.
    finishedToolCalls: new Set(),
    planEntries: [],
    planOverview: undefined,
    planDetail: undefined,
    // merge:false replaces the list, merge:true upserts by id. Entries always arrive complete,
    // so a keyed set is enough — no field-level merging.
    todos: new Map(),
    sawTodoFrame: false,
    touched: new Set(),
    lastToolLabel: null,
    sessionTitle: undefined,
  };
}

/**
 * @param {{ onProgress?: (message: string) => void, progressThrottleMs?: number }} [opts]
 */
export function makeTurnState({ onProgress, progressThrottleMs = 2000 } = {}) {
  const state = {
    ...freshFields(),
    thoughts: progressStream("thinking: ", onProgress, progressThrottleMs),
    messages: progressStream("Cursor: ", onProgress, progressThrottleMs),

    reset() {
      Object.assign(state, freshFields());
      state.thoughts.reset();
      state.messages.reset();
    },

    text() {
      return state.resultChunks.join("");
    },

    resetResult() {
      if (state.resultChunks.length > 0) state.discardedResult = state.resultChunks.join("");
      state.resultChunks.length = 0;
    },

    // The stream is the model's own message, bounded by its output limit; a byte cap
    // here would hand back a partial answer as if it were the whole one.
    appendResult(text) {
      state.resultChunks.push(text);
    },

    startTool(toolCallId, status) {
      state.sawToolCall = true;
      state.collectingPostToolResult = false;
      state.resetResult();
      if (toolCallId != null && !isTerminalToolStatus(status)) {
        state.activeToolCalls.add(toolCallId);
        // A fresh tool_call frame for a finished id is the agent reusing it, not history.
        state.finishedToolCalls.delete(toolCallId);
      }
      if (toolCallId != null && isTerminalToolStatus(status)) state.finishedToolCalls.add(toolCallId);
      if (isTerminalToolStatus(status) && state.activeToolCalls.size === 0) state.collectingPostToolResult = true;
    },

    updateToolStatus(toolCallId, status) {
      if (!status) return;
      if (toolCallId != null && !isTerminalToolStatus(status) && state.finishedToolCalls.has(toolCallId)) return;
      if (!state.sawToolCall) {
        state.sawToolCall = true;
        state.resetResult();
      }
      if (isTerminalToolStatus(status)) {
        if (toolCallId != null) {
          state.activeToolCalls.delete(toolCallId);
          state.finishedToolCalls.add(toolCallId);
        }
        if (state.activeToolCalls.size === 0 && !state.collectingPostToolResult) {
          // Discard any message text emitted while tools were still running.
          // A duplicate or late terminal update must not wipe an already-collected final message.
          state.resetResult();
          state.collectingPostToolResult = true;
        }
      } else {
        state.collectingPostToolResult = false;
        state.resetResult();
        if (toolCallId != null) state.activeToolCalls.add(toolCallId);
      }
    },

    // True while a message chunk still belongs in the result: before any tool ran, or after
    // the last one finished.
    collectingResult() {
      return !state.sawToolCall || (state.collectingPostToolResult && state.activeToolCalls.size === 0);
    },

    todoLabel() {
      const entries = [...state.todos.values()].filter((t) => typeof t?.content === "string");
      if (!entries.length) return null;
      const i = entries.findIndex((t) => t.status === "in_progress");
      if (i !== -1) return `todo ${i + 1}/${entries.length}: ${entries[i].content}`;
      const done = entries.filter((t) => t.status === "completed").length;
      return `todos ${done}/${entries.length} complete`;
    },

    recordTodos({ todos: incoming, merge }) {
      if (!Array.isArray(incoming)) return;
      state.sawTodoFrame = true;
      if (merge === false) state.todos = new Map();
      for (const t of incoming) {
        if (t?.id === undefined || t?.id === null) continue;
        state.todos.set(String(t.id), t);
      }
      const label = state.todoLabel();
      if (label) { try { onProgress?.(label.slice(0, 200)); } catch {} }
    },

    recordCreatePlan(body) {
      if (body?.overview !== undefined) state.planOverview = body.overview;
      if (body?.plan !== undefined) state.planDetail = body.plan;
    },
  };
  return state;
}
