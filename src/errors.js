/**
 * Every failure carries a `reason`, so a caller can tell "fix your arguments" from "retry"
 * without parsing prose. Errors off the wire also carry the agent's JSON-RPC `code`.
 *
 * @typedef {Error & { reason?: string, code?: number }} DelegateError
 */

/**
 * @param {string} reason
 * @param {string} message
 * @returns {DelegateError}
 */
export function makeError(reason, message) {
  /** @type {DelegateError} */
  const err = new Error(message);
  err.reason = reason;
  return err;
}
