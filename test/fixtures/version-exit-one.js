#!/usr/bin/env node
// Accepts --version and exits 1: doctor must report agent.error, not a mute launcher.
if (process.argv.includes("--version")) {
  console.log("should-not-count");
  process.exit(1);
}
process.exit(1);
