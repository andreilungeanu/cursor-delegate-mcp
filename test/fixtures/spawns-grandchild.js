// Spawns a grandchild that ignores SIGTERM, then hangs. The grandchild pid goes to the file in
// argv[2] so the test can assert the whole tree died rather than only the direct child. stdio is
// ignored so the grandchild does not hold the stdout pipe the parent reads.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import process from "node:process";

const grandchild = spawn(
  process.execPath,
  ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1 << 30);"],
  { stdio: "ignore" }
);
// Newline-terminated so a reader can tell a complete write from a partial one.
writeFileSync(process.argv[2], `${grandchild.pid}\n`);
setInterval(() => {}, 1 << 30);
