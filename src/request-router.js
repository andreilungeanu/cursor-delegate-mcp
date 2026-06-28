const ACK_METHODS = new Set(["cursor/update_todos", "cursor/task", "cursor/generate_image"]);

export function createRequestRouter({ respond, respondError, onElicit, onCreatePlan, mode = "agent", log = () => {} }) {
  return async function handle(id, method, params) {
    try {
      if (method === "session/request_permission") {
        const opts = params?.options || [];
        const pick =
          opts.find((o) => o.kind === "allow_always") ||
          opts.find((o) => o.kind === "allow_once") ||
          opts[0];
        return respond(id, { outcome: { outcome: "selected", optionId: pick?.optionId } });
      }
      if (method === "cursor/ask_question") {
        const ans = onElicit
          ? await onElicit({ kind: "ask_question", title: params?.title, questions: params?.questions || [], raw: params })
          : null;
        if (ans?.answers?.length) {
          return respond(id, { outcome: { outcome: "answered", answers: ans.answers } });
        }
        return respond(id, { outcome: { outcome: "cancelled" } });
      }
      if (method === "cursor/create_plan") {
        onCreatePlan?.({
          overview: params?.overview,
          plan: params?.plan,
          name: params?.name,
          raw: params,
        });
        const outcome = mode === "agent" ? "accepted" : "rejected";
        return respond(id, { outcome: { outcome } });
      }
      if (ACK_METHODS.has(method)) {
        log({ method, params });
        return respond(id, {});
      }
      return respondError(id, -32601, `Unhandled method: ${method}`);
    } catch (err) {
      return respondError(id, -32000, `Router error: ${err?.message || err}`);
    }
  };
}
