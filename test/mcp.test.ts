import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { main } from "../src/cli.js";
import { packagePath } from "../src/paths.js";

async function audit(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "ci-ledger-mcp-"));
  const log = console.log;
  console.log = () => {};
  try {
    assert.equal(await main(["audit", "--fixture", "--quiet", "--out", join(dir, "out"), "--cache-dir", join(dir, "cache")]), 0);
  } finally {
    console.log = log;
  }
  return join(dir, "out");
}

/** Starts `ci-ledger mcp` as a subprocess and exchanges newline-delimited JSON-RPC with it. */
function client(out: string) {
  const child = spawn(process.execPath, [packagePath("dist", "src", "bin.js"), "mcp", "--out", out], { stdio: ["pipe", "pipe", "pipe"] });
  const pending: Array<(m: Record<string, unknown>) => void> = [];
  createInterface({ input: child.stdout }).on("line", (line) => pending.shift()?.(JSON.parse(line)));
  const request = (msg: unknown) => new Promise<Record<string, unknown>>((resolve) => {
    pending.push(resolve);
    child.stdin.write(typeof msg === "string" ? `${msg}\n` : `${JSON.stringify(msg)}\n`);
  });
  const notify = (msg: unknown) => child.stdin.write(`${JSON.stringify(msg)}\n`);
  return { request, notify, close: () => child.stdin.end(), done: new Promise((r) => child.on("close", r)) };
}

test("the MCP server initializes, lists tools and answers each tool over stdio", async () => {
  const out = await audit();
  const c = client(out);
  const init = await c.request({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
  const result = init.result as { protocolVersion: string; capabilities: { tools: object }; serverInfo: { name: string } };
  assert.equal(result.protocolVersion, "2025-06-18");
  assert.ok(result.capabilities.tools);
  assert.equal(result.serverInfo.name, "ci-ledger");
  c.notify({ jsonrpc: "2.0", method: "notifications/initialized" });

  const list = (await c.request({ jsonrpc: "2.0", id: 2, method: "tools/list" })).result as { tools: Array<{ name: string }> };
  assert.deepEqual(list.tools.map((t) => t.name), ["get_summary", "get_metric", "list_findings", "explain_finding"]);

  const call = async (id: number, name: string, args: object) =>
    (await c.request({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })).result as { content: Array<{ text: string }>; isError?: boolean };
  assert.match((await call(3, "get_summary", {})).content[0]!.text, /model error/);
  assert.equal(JSON.parse((await call(4, "get_metric", { path: "window.days" })).content[0]!.text), 30);
  assert.equal((await call(5, "get_metric", { path: "nope.nothing" })).isError, true);
  const findings = JSON.parse((await call(6, "list_findings", { kind: "fix", limit: 3 })).content[0]!.text);
  assert.equal(findings.findings.length, 3);
  assert.match((await call(7, "explain_finding", { id: "missing-cancellation" })).content[0]!.text, /concurrency/);

  const unknown = await c.request({ jsonrpc: "2.0", id: 8, method: "resources/list" });
  assert.equal((unknown.error as { code: number }).code, -32601);
  const bad = await c.request("{not json");
  assert.equal((bad.error as { code: number }).code, -32700);
  const ping = await c.request({ jsonrpc: "2.0", id: 9, method: "ping" });
  assert.deepEqual(ping.result, {});
  c.close();
  await c.done;
});

test("unknown protocol versions get the latest supported one, and missing outputs are tool errors", async () => {
  const c = client(join(tmpdir(), "ci-ledger-does-not-exist"));
  const init = await c.request({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } });
  assert.equal((init.result as { protocolVersion: string }).protocolVersion, "2025-11-25");
  const res = await c.request({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_findings", arguments: {} } });
  const r = res.result as { isError: boolean; content: Array<{ text: string }> };
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /run `ci-ledger audit` first/);
  c.close();
  await c.done;
});
