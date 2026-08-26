import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeBridgeUrl,
  validateRevisionRequest,
  validateRevisionResponse,
} from "../extension/lib/protocol.js";

const requestInput = {
  scope: "selection",
  instruction: "修正错别字",
  title: "工作手册",
  sourceHash: "a".repeat(64),
  blocks: [
    { id: "u1", kind: "paragraph", text: "原始文字", editable: true, canInsertAfter: true, canDelete: true },
    { id: "u2", kind: "table", text: "表格内容", editable: false, canInsertAfter: false, canDelete: false },
  ],
};

test("协议接受合法的三类操作", () => {
  const request = validateRevisionRequest(requestInput);
  const revision = validateRevisionResponse({
    sourceHash: request.sourceHash,
    summary: "一处修改和一处新增",
    operations: [
      { op: "insert_paragraph_after", blockId: "u1", oldText: "原始文字", newText: "新增段落", reason: "补充", factChange: true },
      { op: "replace_text", blockId: "u1", oldText: "原始文字", newText: "修订文字", reason: "纠错", factChange: false },
    ],
    warnings: ["新增内容涉及事实变化"],
  }, request);
  assert.equal(revision.operations.length, 2);
});

test("协议拒绝修改只读结构", () => {
  const request = validateRevisionRequest(requestInput);
  assert.throws(() => validateRevisionResponse({
    sourceHash: request.sourceHash,
    summary: "",
    operations: [
      { op: "replace_text", blockId: "u2", oldText: "表格内容", newText: "修改表格", reason: "错误", factChange: false },
    ],
    warnings: [],
  }, request), /只读/u);
});

test("协议拒绝过期原文、换行和重复目标", () => {
  const request = validateRevisionRequest(requestInput);
  const base = { sourceHash: request.sourceHash, summary: "", warnings: [] };
  assert.throws(() => validateRevisionResponse({ ...base, operations: [
    { op: "replace_text", blockId: "u1", oldText: "旧版本", newText: "新版本", reason: "", factChange: false },
  ] }, request), /不匹配/u);
  assert.throws(() => validateRevisionResponse({ ...base, operations: [
    { op: "replace_text", blockId: "u1", oldText: "原始文字", newText: "两段\n文字", reason: "", factChange: false },
  ] }, request), /换行/u);
  assert.throws(() => validateRevisionResponse({ ...base, operations: [
    { op: "replace_text", blockId: "u1", oldText: "原始文字", newText: "版本一", reason: "", factChange: false },
    { op: "delete_paragraph", blockId: "u1", oldText: "原始文字", newText: "", reason: "", factChange: false },
  ] }, request), /重复/u);
});

test("桥接服务地址必须绑定 127.0.0.1", () => {
  assert.equal(normalizeBridgeUrl("http://127.0.0.1:32145/"), "http://127.0.0.1:32145");
  assert.throws(() => normalizeBridgeUrl("http://localhost:32145"), /127\.0\.0\.1/u);
  assert.throws(() => normalizeBridgeUrl("https://127.0.0.1:32145"), /127\.0\.0\.1/u);
});
