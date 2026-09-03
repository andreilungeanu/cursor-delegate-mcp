#!/usr/bin/env node
// Same as agent-stub.js but .mjs, so the version probe must run it with node (not as a binary).
if (process.argv.includes("--version")) {
  console.log("fake-agent-mjs 2.0.0");
  process.exit(0);
}
process.exit(1);
