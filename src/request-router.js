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
        // The two allow kinds only. Taking opts[0] when neither is offered returned a reject
        // id under a `selected` outcome, which the agent reads as an approval of the denial —
        // a silent skip from a bridge that advertises auto-approval.
        const pick =
          opts.find((o) => o.kind === "allow_always") ||
          opts.find((o) => o.kind === "allow_once");
        // Selecting nothing is not a selection: an options-less request answered with
        // optionId undefined is a malformed ACP response, and a request offering no allow
        // option is one this bridge can approve nothing in. Say cancelled to both and let the
        // agent decide what to do about it.
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
      // -32603, not -32000: ACP assigns -32000 to auth_required, and a bug on this side
      // reported as "authenticate" sends the agent down a recovery path that cannot work.
      return respondError(id, -32603, `Router error: ${err?.message || err}`);
    }
  };
}
