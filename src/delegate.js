import { readFileSync, statSync } from "node:fs";
import { AcpClient } from "./acp-client.js";
import { SessionSupervisor } from "./session-supervisor.js";
import { gitChangedSet as gitChangedSetReal, computeTouched } from "./touched-files.js";

function resolveSpec(spec) {
  if (typeof spec !== "string") return spec;
  const looksLikePath = !spec.includes("\n")
    && (spec.includes("/") || spec.includes("\\") || spec.endsWith(".md") || spec.endsWith(".txt"));
  if (!looksLikePath) return spec;
  try {
    if (statSync(spec).isFile()) return readFileSync(spec, "utf8");
  } catch {}
  return spec;
}

async function openSession(client, resumeSessionId, workspace) {
  if (!resumeSessionId) return client.newSession(workspace);
  try {
    await client.loadSession(resumeSessionId, workspace);
    return { sessionId: resumeSessionId }; // load does not echo sessionId
  } catch {
    // stale or unknown session — start fresh
  }
  return client.newSession(workspace);
}

// Composer bare ids (e.g. composer-2.5) expose standard vs fast via set_config_option.
// Other models use separate ids (e.g. gpt-5-fast) — see agent --list-models.
function composerFastToggleApplies(model) {
  return /^composer-\d+(?:\.\d+)?$/i.test(model);
}

export async function runDelegate({
  spec, mode = "agent", resumeSessionId, workspace,
  model = "composer-2.5", fast = "false", clientFactory, onElicit,
  idleMs = 90000, hardCapMs, timeoutMs, cancelGraceMs = 10000, killGraceMs = 5000,
  onSessionReady, onProgress, gitChangedSet = gitChangedSetReal,
} = {}) {
  const capMs = hardCapMs ?? timeoutMs ?? 3600000;
  const MAX_OUTPUT = 10 * 1024 * 1024;
  const TRUNCATION_MARKER = "\n\n[output truncated at 10MB]";
  const questionsAsked = [];
  const recordQuestions = (q) => {
    if (q.kind !== "ask_question") return;
    for (const question of q.questions || []) {
      if (question?.prompt) questionsAsked.push(question.prompt);
    }
  };
  const wrappedElicit = onElicit
    ? async (q) => { recordQuestions(q); return onElicit(q); }
    : async (q) => { recordQuestions(q); return null; };

  let planEntries = [];
  let planOverview;
  let planDetail;
  const recordCreatePlan = (body) => {
    if (body?.overview !== undefined) planOverview = body.overview;
    if (body?.plan !== undefined) planDetail = body.plan;
  };

  const make = clientFactory || ((opts) => new AcpClient(opts));
  const client = make({ onElicit: wrappedElicit, mode, onCreatePlan: recordCreatePlan });
  const supervisor = new SessionSupervisor(client, { idleMs, hardCapMs: capMs, cancelGraceMs, killGraceMs });

  const textChunks = [];
  let textLength = 0;
  let truncated = false;
  const touched = new Set();
  client.on("update", (u) => {
    const up = u?.update || {};
    if (up.sessionUpdate === "plan") {
      planEntries = up.entries || [];
    }
    if (up.sessionUpdate === "agent_thought_chunk" && up.content?.text) {
      const text = up.content.text;
      const tail = text.length > 200 ? text.slice(-200) : text;
      try { onProgress?.("thinking: " + (tail.trim() || text.slice(0, 200))); } catch {}
    }
    if (up.sessionUpdate === "tool_call") {
      const label = up.title || up.kind || "tool";
      try { onProgress?.("running: " + String(label).slice(0, 200)); } catch {}
    }
    if (up.sessionUpdate === "agent_message_chunk" && up.content?.text) {
      const text = up.content.text;
      if (!truncated) {
        const remaining = MAX_OUTPUT - textLength;
        if (text.length <= remaining) {
          textChunks.push(text);
          textLength += text.length;
        } else if (remaining > 0) {
          textChunks.push(text.slice(0, remaining));
          textLength += remaining;
          truncated = true;
        } else {
          truncated = true;
        }
      }
      const tail = text.length > 200 ? text.slice(-200) : text;
      try { onProgress?.(tail.trim() || text.slice(0, 200)); } catch {}
    }
    if (up.sessionUpdate === "tool_call_update") {
      for (const c of up.content || []) {
        if (c.type === "diff" && c.path) {
          touched.add(c.path);
          try { onProgress?.("editing " + c.path); } catch {}
        }
      }
    }
  });

  try {
    let sessionId;
    const gitBefore = gitChangedSet(workspace); // before/after delta catches shell edits
    const res = await supervisor.supervise(async () => {
      await client.start();
      await client.initialize();
      const sess = await openSession(client, resumeSessionId, workspace);
      sessionId = sess.sessionId;
      supervisor.setSessionId(sessionId);
      onSessionReady?.(sessionId, client);
      await client.setModel(sessionId, model);
      if (composerFastToggleApplies(model)) await client.setFast(sessionId, fast);
      await client.setMode(sessionId, mode);
      textChunks.length = 0;
      textLength = 0;
      truncated = false;
      planEntries = [];
      planOverview = undefined;
      planDetail = undefined;
      touched.clear();
      return client.prompt(sessionId, resolveSpec(spec));
    });
    let result = textChunks.join("");
    if (truncated) result += TRUNCATION_MARKER;
    const gitAfter = gitChangedSet(workspace);
    const touchedResult = computeTouched({ before: gitBefore, after: gitAfter, diffTouched: [...touched], workspace });
    const out = {
      result,
      stopReason: res?.stopReason,
      sessionId,
      touchedFiles: touchedResult.files,
      touchedFilesSource: touchedResult.source,
      questionsAsked,
      resumed: !!resumeSessionId && sessionId === resumeSessionId,
    };
    if (planEntries.length > 0 || planOverview !== undefined || planDetail !== undefined) {
      out.plan = { entries: planEntries, overview: planOverview, detail: planDetail };
    }
    return out;
  } catch (err) {
    try {
      const transcript = client.getTranscript?.(40);
      if (transcript) err.message += "\n\n--- recent ACP transcript (last 40 frames) ---\n" + transcript;
    } catch {}
    throw err;
  } finally {
    try { supervisor.finish(); } catch {}
    client.stop();
  }
}
