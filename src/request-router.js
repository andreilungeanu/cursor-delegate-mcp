const ACK_METHODS = new Set(["cursor/task", "cursor/generate_image"]);

/**
 * @param {{
 *   respond: (id: any, result: any) => void,
 *   respondError: (id: any, code: number, message: string) => void,
 *   onCreatePlan?: (body: any) => void,
 *   onTodos?: (body: any) => void,
 *   mode?: string,
 *   log?: (entry: any) => void,
 * }} deps
 */
export function createRequestRouter({ respond, respondError, onCreatePlan, onTodos, mode = "agent", log = () => {} }) {
  return async function handle(id, method, params) {
    try {
      if (method === "session/request_permission") {
        const opts = params?.options || [];
        const pick =
          opts.find((o) => o.kind === "allow_always") ||
          opts.find((o) => o.kind === "allow_once") ||
          opts[0];
        // Selecting nothing is not a selection: an options-less request answered with
        // optionId undefined is a malformed ACP response. Say cancelled and let the agent
        // decide what to do about it.
        if (!pick?.optionId) return respond(id, { outcome: { outcome: "cancelled" } });
        return respond(id, { outcome: { outcome: "selected", optionId: pick.optionId } });
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
      if (method === "cursor/update_todos") {
        onTodos?.({ todos: params?.todos, merge: params?.merge, toolCallId: params?.toolCallId });
        log({ method, params });
        // The documented response is {outcome:{outcome:"accepted", todos}}; the bare {} we
        // have always sent is accepted by cursor-agent, so it stays until that changes.
        return respond(id, {});
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
