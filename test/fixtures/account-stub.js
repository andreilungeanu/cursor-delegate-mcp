#!/usr/bin/env node
// Answers doctor's CLI probes: `--version`, `status --format json`, `about --format json`.
// The first argument picks the account: "signed-in", "logged-out" or "outdated".
const [mode, ...rest] = process.argv.slice(2);
const call = rest.join(" ");
if (call === "--version") {
  console.log("2026.11.22-e9042b2");
} else if (call === "status --format json") {
  console.log(JSON.stringify({ status: mode === "logged-out" ? "unauthenticated" : "authenticated", isAuthenticated: mode !== "logged-out" }));
} else if (call === "about --format json") {
  console.log(JSON.stringify({
    cliVersion: "2026.11.22-e9042b2",
    latestVersion: mode === "outdated" ? "2026.11.30-aaaaaaa" : "2026.11.22-e9042b2",
    subscriptionTier: mode === "logged-out" ? null : "Plus",
    userEmail: "someone@example.com",
  }));
} else {
  process.exit(1);
}
