// fake-acp.js, or the fixture AGENT_BASE names, plus a grandchild that keeps running until killed.
// Both pids go to the file named by PID_FILE, so a test can check the whole tree is gone.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import process from "node:process";

const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30);"], { stdio: "ignore" });
writeFileSync(process.env.PID_FILE, `${process.pid} ${grandchild.pid}\n`);
await import(process.env.AGENT_BASE ?? "./fake-acp.js");
