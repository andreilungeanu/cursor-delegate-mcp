/**
 * Every failure this bridge raises carries a `reason`, which is what lets a caller tell
 * "fix your arguments" from "retry" without parsing prose. Errors that came off the wire also
 * carry the agent's JSON-RPC `code`. One shape, one constructor, so the tag is never forgotten
 * and the type checker has something to check against.
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
