#!/usr/bin/env node
// Minimal stub for doctor agent.version probes: `stub --version` prints a version string.
if (process.argv.includes("--version")) {
  console.log("fake-agent 2.0.0");
  process.exit(0);
}
process.exit(1);
