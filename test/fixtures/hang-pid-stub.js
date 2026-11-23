// Appends "<pid> <args>" to $CURSOR_TEST_PIDLOG, then answers nothing: not --version, not ACP.
import { appendFileSync } from "node:fs";
import process from "node:process";

appendFileSync(process.env.CURSOR_TEST_PIDLOG, `${process.pid} ${process.argv.slice(2).join(" ")}\n`);
setInterval(() => {}, 1000);
