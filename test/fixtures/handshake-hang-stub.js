// Hangs on initialize — never responds (handshake idle-timeout probe).
import readline from "node:readline";

readline.createInterface({ input: process.stdin }).on("line", () => {});
