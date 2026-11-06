import { ensureRuntimeDependencies } from "./ensure-deps.mjs";

// Loaded with `node --import` before src/server.js. Stdout is reserved for MCP JSON-RPC.
await ensureRuntimeDependencies();
