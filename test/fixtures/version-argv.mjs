#!/usr/bin/env node
// Answers --version with the arguments it received, so a test can pin exactly what the probe sent.
if (process.argv.includes("--version")) console.log(JSON.stringify(process.argv.slice(2)));
