import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createBridgeServer, resolveRunnerSpec } from "../bridge/server.mjs";

const origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const token = "1".repeat(48);
const request = {
  scope: "selection",
  instruction: "修正错别字",
  title: "测试",
  sourceHash: "b".repeat(64),
  blocks: [
    { id: "p1", kind: "paragraph", text: "错吴", editable: true, canInsertAfter: true, canDelete: true },
  ],
};

async function withServer(run, callback) {
  const server = createBridgeServer({ token, run });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  try { await callback(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test("桥接服务校验来源、配对码和 Codex 结果", async () => {
  await withServer(async (validated) => ({
    sourceHash: validated.sourceHash,
    summary: "修正一处错别字",
    operations: [
      { op: "replace_text", blockId: "p1", oldText: "错吴", newText: "错误", reason: "错别字", factChange: false },
    ],
    warnings: [],
  }), async (baseUrl) => {
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);

    const denied = await fetch(`${baseUrl}/v1/revise`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json", Authorization: "Bearer wrong" },
      body: JSON.stringify(request),
    });
    assert.equal(denied.status, 401);

    const response = await fetch(`${baseUrl}/v1/revise`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(request),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
    const body = await response.json();
    assert.equal(body.operations[0].newText, "错误");
  });
});

test("Windows 运行器能从 WSL UNC 项目路径推导参数", () => {
  const runner = resolveRunnerSpec({
    YUQUE_AI_PROJECT_WIN: "\\\\wsl.localhost\\Ubuntu\\home\\administer\\语雀AI编辑器\\",
  }, "win32");
  assert.equal(runner.command, "wsl.exe");
  assert.deepEqual(runner.argsPrefix.slice(0, 3), ["-d", "Ubuntu", "--"]);
  assert.ok(runner.argsPrefix.includes("/home/administer/语雀AI编辑器/bridge/run-codex.sh"));
});
