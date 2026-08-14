// Answers --version on stdout, but writes 640KB to stderr first. A parent that opens stderr as
// a pipe and never reads it leaves this process unable to drain its own write buffer, so it
// never exits and the probe can only end at its timeout — reported as "spawned but never
// answered", which is a different diagnosis from the truth.
// Exits naturally rather than via process.exit, which would abandon the queued writes and let
// the process die whether or not anyone drained it.
const CHUNK = "x".repeat(20000);
for (let i = 0; i < 32; i++) process.stderr.write(CHUNK);
process.stdout.write("fake-agent 3.0.0\n");
