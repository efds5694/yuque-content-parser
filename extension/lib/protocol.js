export const BRIDGE_DEFAULT_URL = "http://127.0.0.1:32145";
export const MAX_BLOCKS = 500;
export const MAX_DOCUMENT_CHARS = 100_000;
export const MAX_OPERATIONS = 200;

export const OPERATION_TYPES = Object.freeze({
  REPLACE: "replace_text",
  INSERT: "insert_paragraph_after",
  DELETE: "delete_paragraph",
});

export function normalizeBridgeUrl(value) {
  const raw = String(value || BRIDGE_DEFAULT_URL).trim().replace(/\/$/, "");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("本地服务地址无效");
  }
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") {
    throw new Error("为保护文档，本地服务只能使用 http://127.0.0.1");
  }
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("本地服务地址只能包含主机和端口");
  }
  return parsed.origin;
}

export function stableBlockProjection(blocks, includeIds = true) {
  return blocks.map((block) => {
    const projected = {
      kind: String(block.kind),
      text: String(block.text),
      editable: Boolean(block.editable),
      canInsertAfter: Boolean(block.canInsertAfter),
      canDelete: Boolean(block.canDelete),
    };
    if (includeIds) projected.id = String(block.id);
    return projected;
  });
}

export async function sha256(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hashBlocks(blocks, includeIds = true) {
  return sha256(JSON.stringify(stableBlockProjection(blocks, includeIds)));
}

function assertString(value, label, maxLength = 100_000) {
  if (typeof value !== "string") throw new Error(`${label} 必须是字符串`);
  if (value.length > maxLength) throw new Error(`${label} 过长`);
  return value;
}

function assertSingleParagraph(value, label) {
  assertString(value, label, 10_000);
  if (/[\r\n\u2028\u2029]/u.test(value)) {
    throw new Error(`${label} 不能包含换行；第一版每项操作只能处理一个段落`);
  }
  if (/\u0000/u.test(value)) throw new Error(`${label} 含有无效控制字符`);
}

export function validateRevisionRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("请求体必须是对象");
  }
  const scope = input.scope;
  if (scope !== "selection" && scope !== "document") throw new Error("编辑范围无效");
  const instruction = assertString(input.instruction, "修改要求", 20_000).trim();
  if (!instruction) throw new Error("请输入修改要求");
  const title = assertString(input.title || "", "标题", 1_000);
  const sourceHash = assertString(input.sourceHash, "文档哈希", 128);
  if (!/^[a-f0-9]{64}$/u.test(sourceHash)) throw new Error("文档哈希格式无效");
  if (!Array.isArray(input.blocks) || input.blocks.length === 0) throw new Error("没有可供审阅的段落");
  if (input.blocks.length > MAX_BLOCKS) throw new Error(`段落数量超过 ${MAX_BLOCKS} 个上限`);

  let chars = 0;
  const ids = new Set();
  const blocks = input.blocks.map((raw, index) => {
    if (!raw || typeof raw !== "object") throw new Error(`第 ${index + 1} 个段落无效`);
    const id = assertString(raw.id, "段落 ID", 256);
    if (!id || ids.has(id)) throw new Error(`段落 ID 缺失或重复：${id || index + 1}`);
    ids.add(id);
    const text = assertString(raw.text, "段落文字", 20_000);
    chars += text.length;
    return {
      id,
      kind: assertString(raw.kind, "段落类型", 64),
      text,
      editable: Boolean(raw.editable),
      canInsertAfter: Boolean(raw.canInsertAfter),
      canDelete: Boolean(raw.canDelete),
    };
  });
  if (chars > MAX_DOCUMENT_CHARS) throw new Error(`文字数量超过 ${MAX_DOCUMENT_CHARS} 字上限`);
  return { scope, instruction, title, sourceHash, blocks };
}

export function validateRevisionResponse(input, request) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("AI 返回结果不是对象");
  if (input.sourceHash !== request.sourceHash) throw new Error("AI 返回的文档版本与当前请求不一致");
  const summary = assertString(input.summary || "", "修订摘要", 10_000);
  const warnings = Array.isArray(input.warnings)
    ? input.warnings.map((item) => assertString(item, "警告", 2_000))
    : (() => { throw new Error("warnings 必须是数组"); })();
  if (!Array.isArray(input.operations)) throw new Error("operations 必须是数组");
  if (input.operations.length > MAX_OPERATIONS) throw new Error(`修改项超过 ${MAX_OPERATIONS} 个上限`);

  const blockById = new Map(request.blocks.map((block) => [block.id, block]));
  const destructiveTargets = new Set();
  const insertionTargets = new Set();
  const operations = input.operations.map((raw, index) => {
    if (!raw || typeof raw !== "object") throw new Error(`第 ${index + 1} 项修改无效`);
    const op = raw.op;
    if (!Object.values(OPERATION_TYPES).includes(op)) throw new Error(`第 ${index + 1} 项操作类型无效`);
    const blockId = assertString(raw.blockId, "目标段落 ID", 256);
    const block = blockById.get(blockId);
    if (!block) throw new Error(`AI 引用了范围外的段落：${blockId}`);
    const oldText = assertString(raw.oldText, "原文字", 20_000);
    const newText = assertString(raw.newText, "新文字", 20_000);
    const reason = assertString(raw.reason || "", "修改理由", 2_000);
    if (typeof raw.factChange !== "boolean") throw new Error(`第 ${index + 1} 项 factChange 必须为布尔值`);
    if (oldText !== block.text) throw new Error(`目标段落 ${blockId} 的原文字不匹配`);

    if (op === OPERATION_TYPES.REPLACE) {
      if (!block.editable) throw new Error(`目标段落 ${blockId} 是只读内容`);
      assertSingleParagraph(newText, "替换文字");
      if (!newText || newText === oldText) throw new Error(`目标段落 ${blockId} 的替换没有产生有效变化`);
      if (destructiveTargets.has(blockId)) throw new Error(`目标段落 ${blockId} 存在重复修改`);
      destructiveTargets.add(blockId);
    } else if (op === OPERATION_TYPES.INSERT) {
      if (!block.canInsertAfter) throw new Error(`不能在目标段落 ${blockId} 后创建段落`);
      assertSingleParagraph(newText, "新段落文字");
      if (!newText) throw new Error("新段落不能为空");
      if (insertionTargets.has(blockId)) throw new Error(`目标段落 ${blockId} 后存在多个新段落`);
      insertionTargets.add(blockId);
    } else {
      if (!block.canDelete) throw new Error(`不能删除目标段落 ${blockId}`);
      if (newText !== "") throw new Error("删除段落时 newText 必须为空");
      if (destructiveTargets.has(blockId)) throw new Error(`目标段落 ${blockId} 存在重复修改`);
      destructiveTargets.add(blockId);
    }
    return { op, blockId, oldText, newText, reason, factChange: raw.factChange };
  });

  return { sourceHash: input.sourceHash, summary, operations, warnings };
}

export const REVISION_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    sourceHash: { type: "string" },
    summary: { type: "string" },
    operations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          op: { type: "string", enum: Object.values(OPERATION_TYPES) },
          blockId: { type: "string" },
          oldText: { type: "string" },
          newText: { type: "string" },
          reason: { type: "string" },
          factChange: { type: "boolean" }
        },
        required: ["op", "blockId", "oldText", "newText", "reason", "factChange"],
        additionalProperties: false
      }
    },
    warnings: { type: "array", items: { type: "string" } }
  },
  required: ["sourceHash", "summary", "operations", "warnings"],
  additionalProperties: false
});
