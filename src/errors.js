/**
 * Every failure carries a `reason`, so a caller can tell "fix your arguments" from "retry"
 * without parsing prose. Errors off the wire also carry the agent's JSON-RPC `code`. A note goes on
 * a new error with the old one as its `cause`: a caught error may be frozen or a primitive.
 *
 * @typedef {Error & { reason?: string, code?: number }} DelegateError
 */

/**
 * @param {string | undefined} reason
 * @param {string} message
 * @param {{ code?: number, cause?: unknown }} [extra]
 * @returns {Readonly<DelegateError>}
 */
export function makeError(reason, message, { code, cause } = {}) {
  /** @type {DelegateError} */
  const err = new Error(message, cause === undefined ? undefined : { cause });
  if (reason !== undefined) err.reason = reason;
  if (code !== undefined) err.code = code;
  return err;
}
