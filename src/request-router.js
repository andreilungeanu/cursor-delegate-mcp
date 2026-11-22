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
        // Allow kinds only: opts[0] can be a reject option, and selecting it silently denies.
        const pick =
          opts.find((o) => o.kind === "allow_always") ||
          opts.find((o) => o.kind === "allow_once");
        // With no allow option there is nothing to select; cancelled is the valid ACP answer.
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
        if (id == null) return;
        // The documented reply is {outcome:{outcome:"accepted", todos}}; cursor-agent accepts {}.
        return respond(id, {});
      }
      if (ACK_METHODS.has(method)) {
        log({ method, params });
        return respond(id, {});
      }
      return respondError(id, -32601, `Unhandled method: ${method}`);
    } catch (err) {
      // -32603, not -32000: ACP reserves -32000 for auth_required, which sends the agent to log in.
      if (id != null) return respondError(id, -32603, `Router error: ${err?.message || err}`);
    }
  };
}
