import { homedir } from "node:os";
import path from "node:path";
import { jobIdSchema } from "./job-contract.js";

/**
 * @param {{
 *   platform?: NodeJS.Platform,
 *   env?: NodeJS.ProcessEnv,
 *   homeDir?: string,
 * }} [options]
 */
export function resolveJobRoot(options = {}) {
  const {
    platform = process.platform,
    env = process.env,
    homeDir = homedir(),
  } = options;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const override = env.CURSOR_DELEGATE_STATE_DIR;
  if (override) return pathApi.join(pathApi.resolve(override), "jobs");
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA || pathApi.join(homeDir, "AppData", "Local");
    return pathApi.join(localAppData, "cursor-delegate-mcp", "jobs");
  }
  const stateHome = env.XDG_STATE_HOME || pathApi.join(homeDir, ".local", "state");
  return pathApi.join(stateHome, "cursor-delegate-mcp", "jobs");
}

/**
 * @param {string} root
 * @param {string} jobId
 */
export function jobDirectory(root, jobId) {
  const parsed = jobIdSchema.safeParse(jobId);
  if (!parsed.success) {
    const error = /** @type {Error & { reason: string }} */ (
      new Error("jobId must be a UUID v4")
    );
    error.reason = "invalid-job-id";
    throw error;
  }
  const resolvedRoot = path.resolve(root);
  const resolvedJob = path.resolve(resolvedRoot, jobId);
  if (path.dirname(resolvedJob) !== resolvedRoot) {
    const error = /** @type {Error & { reason: string }} */ (
      new Error("job path escaped the configured state directory")
    );
    error.reason = "invalid-job-id";
    throw error;
  }
  return resolvedJob;
}
