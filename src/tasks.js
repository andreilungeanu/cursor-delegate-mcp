import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CLIENT_CAPABILITIES_META_KEY, MissingRequiredClientCapabilityError, ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";

// The MCP Tasks extension, 2026-07-28: https://modelcontextprotocol.io/extensions/tasks/overview
export const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";

const RETAIN_MS = 60 * 60 * 1000;
const FAST_POLL_MS = 3000;
const SLOW_POLL_MS = 10000;
const FAST_POLL_FOR_MS = 60 * 1000;

// Claude Code lists the extension only on a call that can become a task: not from a subagent.
export function listsTasks(ctx) {
  return ctx?.mcpReq?.envelope?.[CLIENT_CAPABILITIES_META_KEY]?.extensions?.[TASKS_EXTENSION] != null;
}

/**
 * @typedef {{
 *   taskId: string, status: "working" | "completed" | "failed" | "cancelled",
 *   createdAt: number, lastUpdatedAt: number, endedAt?: number, statusMessage?: string,
 *   sessionId?: string, handle?: any, resumeNote?: string, turnEnded: boolean, ac: AbortController,
 *   result?: any, error?: { code: number, message: string },
 * }} Task
 */

/** @param {{ now?: () => number, retainMs?: number }} [opts] */
export function createTaskStore({ now = Date.now, retainMs = RETAIN_MS } = {}) {
  /** @type {Map<string, Task>} */
  const tasks = new Map();
  // A dropped task's session, so its id still resumes it: the host shows the model only the task id.
  /** @type {Map<string, string>} */
  const sessions = new Map();
  // A running task is never dropped: its id is the host's only handle on the run.
  const prune = () => {
    const t = now();
    for (const task of tasks.values()) {
      if (task.endedAt === undefined || t - task.endedAt <= retainMs) continue;
      tasks.delete(task.taskId);
      if (task.sessionId) sessions.set(task.taskId, task.sessionId);
    }
  };
  // A fact that changes what to do after a cancel, such as an agent the stop could not confirm exited.
  /** @param {Task} task @param {string} text */
  const note = (task, text) => {
    if (task.status !== "cancelled") return;
    const base = task.statusMessage ?? "cancelled";
    task.statusMessage = `${base}${base.endsWith(".") ? "" : "."} Note: ${text}`;
    task.lastUpdatedAt = now();
  };
  return {
    now,
    note,
    /** @returns {Task} */
    create() {
      const t = now();
      return { taskId: randomUUID(), status: "working", createdAt: t, lastUpdatedAt: t, turnEnded: false, ac: new AbortController() };
    },
    /** @param {Task} task */
    add(task) { prune(); tasks.set(task.taskId, task); },
    /** @param {string} taskId */
    get(taskId) { prune(); return tasks.get(taskId); },
    /** @param {string | undefined} taskId */
    sessionOf(taskId) {
      if (taskId === undefined) return undefined;
      prune();
      return tasks.get(taskId)?.sessionId ?? sessions.get(taskId);
    },
    // A cancelled task keeps its own status message: the run's error names the abort, a reason no
    // blocking call returns.
    /** @param {Task} task @param {{ result?: any, error?: any }} outcome */
    finish(task, outcome) {
      if (task.status === "working") {
        task.endedAt = task.lastUpdatedAt = now();
        // The last progress line is stale once the run is over; a failure says why instead.
        if ("error" in outcome) {
          task.status = "failed";
          task.error = { code: ProtocolErrorCode.InternalError, message: String(outcome.error?.message ?? outcome.error) };
          task.statusMessage = task.error.message;
        } else {
          task.status = "completed";
          // The tools/call result a 2026-07-28 host would have read, marked as one.
          task.result = { ...outcome.result, resultType: "complete" };
          task.statusMessage = undefined;
        }
      }
      prune();
    },
    // A turn that has ended has its result decided, so a cancel leaves it, as the cancel tool does.
    /** @param {Task} task */
    cancel(task) {
      if (task.status !== "working" || task.turnEnded) return;
      task.status = "cancelled";
      task.statusMessage = task.sessionId ? `cancelled; resume with resumeSessionId ${task.sessionId}` : "cancelled";
      if (task.resumeNote) note(task, task.resumeNote);
      task.endedAt = task.lastUpdatedAt = now();
      task.ac.abort();
    },
    /** @param {Task} task */
    view(task) {
      const t = now();
      /** @type {Record<string, any>} */
      const view = {
        taskId: task.taskId,
        status: task.status,
        createdAt: new Date(task.createdAt).toISOString(),
        lastUpdatedAt: new Date(task.lastUpdatedAt).toISOString(),
        ttlMs: task.endedAt === undefined ? null : task.endedAt - task.createdAt + retainMs,
        pollIntervalMs: t - task.createdAt < FAST_POLL_FOR_MS ? FAST_POLL_MS : SLOW_POLL_MS,
      };
      if (task.statusMessage) view.statusMessage = task.statusMessage;
      if (task.status === "completed") view.result = task.result;
      if (task.status === "failed") view.error = task.error;
      return view;
    },
  };
}

/**
 * Runs a delegation that answers its request with a task once the prompt is sent. A run that
 * settles before then, setup failures included, answers with its result as a blocking call does.
 * @param {{
 *   run: (over: { signal: AbortSignal, onProgress: (m: string) => void, onPromptSent: (id: string, handle?: any, resumeNote?: string) => void, onUnseenExit: (note: string) => void, onTurnEnd: () => void }) => Promise<any>,
 *   signal?: AbortSignal, notify?: (message: string) => void, store: ReturnType<typeof createTaskStore>,
 * }} opts
 */
export async function runAsTask({ run, signal, notify = () => {}, store }) {
  const task = store.create();
  let answered = false;
  /** @type {() => void} */
  let markSent = () => {};
  const sent = new Promise((resolve) => { markSent = () => resolve(undefined); });
  // Until the task is answered the request owns the run, so its cancellation stops the agent.
  const forward = () => task.ac.abort();
  if (signal?.aborted) forward();
  else signal?.addEventListener("abort", forward, { once: true });
  const outcome = run({
    signal: task.ac.signal,
    onProgress: (message) => {
      if (task.status === "working") {
        task.statusMessage = message;
        task.lastUpdatedAt = store.now();
      }
      // Once the task is the answer, progress belongs to the task, not the request.
      if (!answered) notify(message);
    },
    onPromptSent: (sessionId, handle, resumeNote) => { task.sessionId = sessionId; task.handle = handle; task.resumeNote = resumeNote; markSent(); },
    onUnseenExit: (note) => store.note(task, note),
    onTurnEnd: () => { task.turnEnded = true; },
  }).then((result) => ({ result }), (error) => ({ error }));
  const first = await Promise.race([sent, outcome]);
  signal?.removeEventListener("abort", forward);
  // A request cancelled as its prompt goes out is gone, so nobody would receive the task id.
  const settled = first ?? (task.ac.signal.aborted ? await outcome : undefined);
  if (settled) {
    if ("error" in settled) throw settled.error;
    return settled.result;
  }
  answered = true;
  // In the store before the answer goes out: the host polls as soon as it reads the id.
  store.add(task);
  outcome.then((o) => store.finish(task, o));
  return { resultType: "task", ...store.view(task) };
}

const TaskParams = z.object({ taskId: z.string() }).passthrough();
const AnyResult = z.object({}).passthrough();

/** @param {any} server @param {ReturnType<typeof createTaskStore>} store */
export function registerTaskHandlers(server, store) {
  /** @param {string} taskId @param {any} ctx */
  const find = (taskId, ctx) => {
    if (!listsTasks(ctx)) {
      throw new MissingRequiredClientCapabilityError({ requiredCapabilities: { extensions: { [TASKS_EXTENSION]: {} } } });
    }
    const task = store.get(taskId);
    if (!task) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown task: ${taskId}`);
    return task;
  };
  server.server.setRequestHandler("tasks/get", { params: TaskParams, result: AnyResult },
    async (/** @type {any} */ { taskId }, /** @type {any} */ ctx) => store.view(find(taskId, ctx)));
  // A delegation never enters input_required: its questions come back in the result.
  // The SDK lifts inputResponses into ctx before validation, and reads a non-object as an empty map.
  server.server.setRequestHandler("tasks/update", { params: TaskParams, result: AnyResult },
    async (/** @type {any} */ { taskId }, /** @type {any} */ ctx) => {
      find(taskId, ctx);
      if (ctx?.mcpReq?.inputResponses === undefined) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, "tasks/update needs inputResponses");
      }
      return {};
    });
  server.server.setRequestHandler("tasks/cancel", { params: TaskParams, result: AnyResult },
    async (/** @type {any} */ { taskId }, /** @type {any} */ ctx) => { store.cancel(find(taskId, ctx)); return {}; });
}
