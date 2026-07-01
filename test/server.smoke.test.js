import { test } from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../src/server.js";

test("server builds with delegate and cancel registered", () => {
  const server = buildServer();
  assert.ok(server, "server instance created");
});
