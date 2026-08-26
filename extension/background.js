import { diffToHunks } from "./lib/diff.js";
import { OPERATION_TYPES, validateRevisionResponse } from "./lib/protocol.js";

const DEBUG_PROTOCOL_VERSION = "1.3";
const editorFrameCache = new Map();

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

async function activeYuqueTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let isYuque = false;
  try {
    const url = new URL(tab?.url || "");
    isYuque = url.protocol === "https:" && (url.hostname === "yuque.com" || url.hostname.endsWith(".yuque.com"));
  } catch {
    isYuque = false;
  }
  if (!tab?.id || !isYuque) {
    throw new Error("请先打开需要修改的语雀文档，并进入编辑模式");
  }
  return tab;
}

function probeEditorDocument() {
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  };
  const blockSelector = [
    "p", "h1", "h2", "h3", "h4", "h5", "h6", "li",
    "ne-p", "ne-h1", "ne-h2", "ne-h3", "ne-h4", "ne-h5", "ne-h6",
    "ne-tli", "ne-oli-i", "ne-uli-i",
    ".ne-p", ".ne-heading", ".ne-list-item", ".lake-p", ".lake-heading", ".lake-list-item",
    '[data-node-type="paragraph"]', '[data-node-type="heading"]', '[data-node-type="list_item"]',
  ].join(",");
  const candidates = Array.from(document.querySelectorAll('[contenteditable="true"]')).filter(visible);
  for (const selector of [".lake-engine", ".lake-content-editor-core", ".lake-content", "[data-lake-editor]"]) {
    for (const element of document.querySelectorAll(selector)) {
      if (visible(element) && !candidates.includes(element)) candidates.push(element);
    }
  }
  const scored = candidates.map((element) => {
    const lakeIds = element.querySelectorAll("[data-lake-id]").length;
    const blocks = element.querySelectorAll(blockSelector).length;
    const editable = element.matches('[contenteditable="true"]') || Boolean(element.querySelector('[contenteditable="true"]'));
    const textLength = (element.textContent || "").trim().length;
    return {
      score: lakeIds * 100 + blocks * 20 + Math.min(textLength, 10_000) + (editable ? 50 : 0),
      lakeIds,
      blocks,
      editable,
      textLength,
      root: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${element.className ? `.${String(element.className).trim().split(/\s+/u).slice(0, 3).join(".")}` : ""}`,
    };
  }).sort((left, right) => right.score - left.score);
  return {
    href: location.href,
    title: document.title,
    candidateCount: candidates.length,
    best: scored[0] || null,
  };
}

async function discoverEditorFrame(tabId, force = false) {
  if (!force && editorFrameCache.has(tabId)) return editorFrameCache.get(tabId);
  const frames = await chrome.webNavigation.getAllFrames({ tabId }) || [{ frameId: 0, url: "" }];
  const probes = [];
  for (const frame of frames) {
    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frame.frameId] },
        func: probeEditorDocument,
      });
      if (result?.result) probes.push({ frameId: frame.frameId, frameUrl: frame.url, ...result.result });
    } catch {
      // 浏览器内部框架或没有 host permission 的框架不是正文编辑器。
    }
  }
  const ranked = probes
    .filter((probe) => probe.best?.editable)
    .sort((left, right) => (right.best?.score || 0) - (left.best?.score || 0));
  const selected = ranked[0] || probes.find((probe) => probe.frameId === 0);
  if (!selected) throw new Error("无法访问语雀页面框架，请重新加载扩展和文档页面");
  const context = { frameId: selected.frameId, diagnostic: selected, allDiagnostics: probes };
  editorFrameCache.set(tabId, context);
  return context;
}

async function sendContent(tabId, message, retryInjection = true) {
  const frame = await discoverEditorFrame(tabId);
  try {
    const response = await chrome.tabs.sendMessage(tabId, message, { frameId: frame.frameId });
    if (!response?.ok) throw new Error(response?.error || "语雀页面没有返回结果");
    return response.value;
  } catch (error) {
    const text = error?.message || String(error);
    if (retryInjection && /(Receiving end does not exist|Could not establish connection)/iu.test(text)) {
      await chrome.scripting.executeScript({ target: { tabId, frameIds: [frame.frameId] }, files: ["content.js"] });
      return sendContent(tabId, message, false);
    }
    if (retryInjection && /(没有检测到可编辑|离开编辑模式)/u.test(text)) {
      editorFrameCache.delete(tabId);
      await discoverEditorFrame(tabId, true);
      return sendContent(tabId, message, false);
    }
    throw error;
  }
}

chrome.tabs.onRemoved.addListener((tabId) => editorFrameCache.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" || changeInfo.url) editorFrameCache.delete(tabId);
});

async function emitProgress(stage, detail) {
  try {
    await chrome.runtime.sendMessage({ type: "APPLY_PROGRESS", stage, detail });
  } catch {
    // 侧边栏关闭时不影响页面操作。
  }
}

async function attachDebugger(tabId) {
  try {
    await chrome.debugger.attach({ tabId }, DEBUG_PROTOCOL_VERSION);
  } catch (error) {
    throw new Error(`无法连接浏览器输入通道。请关闭该页面的开发者工具后重试。${error?.message ? `（${error.message}）` : ""}`);
  }
}

async function debuggerCommand(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

async function keyPress(tabId, key, code, virtualKeyCode, modifiers = 0) {
  const common = { key, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode, modifiers };
  await debuggerCommand(tabId, "Input.dispatchKeyEvent", { type: "rawKeyDown", ...common });
  await debuggerCommand(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...common });
}

async function insertText(tabId, text) {
  if (text) await debuggerCommand(tabId, "Input.insertText", { text });
  else await keyPress(tabId, "Backspace", "Backspace", 8);
}

function blockFingerprint(block) {
  return block ? `${block.id}\u0000${block.kind}\u0000${block.text}` : null;
}

function sameBlock(left, right) {
  return blockFingerprint(left) === blockFingerprint(right);
}

async function ensureNeighborsUnchanged(tabId, documentKey, before, blockId) {
  const after = await sendContent(tabId, { type: "GET_BLOCK_STATE", documentKey, blockId });
  if (!after.exists) throw new Error(`段落 ${blockId} 在写入后消失`);
  if (!sameBlock(before.previous, after.previous) || !sameBlock(before.next, after.next)) {
    throw new Error(`段落 ${blockId} 的相邻内容发生了意外变化`);
  }
  return after;
}

async function waitUntilAbsent(tabId, documentKey, blockId, timeoutMs = 2_500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await sendContent(tabId, { type: "GET_BLOCK_STATE", documentKey, blockId });
    if (!state.exists) return true;
    await new Promise((resolve) => setTimeout(resolve, 70));
  }
  throw new Error(`段落 ${blockId} 删除后校验失败`);
}

async function verifyKnownBlock(tabId, documentKey, expected) {
  if (!expected) return;
  const state = await sendContent(tabId, { type: "GET_BLOCK_STATE", documentKey, blockId: expected.id });
  if (!state.exists || blockFingerprint(state.block) !== blockFingerprint(expected)) {
    throw new Error(`相邻段落 ${expected.id} 发生了意外变化`);
  }
}

async function applyInsert(tabId, documentKey, operation) {
  let undoUnits = 0;
  try {
    const before = await sendContent(tabId, { type: "GET_BLOCK_STATE", documentKey, blockId: operation.blockId });
    if (!before.exists || before.block.text !== operation.oldText || !before.block.canInsertAfter) {
      throw new Error(`新建段落的锚点 ${operation.blockId} 已变化`);
    }
    await sendContent(tabId, {
      type: "PLACE_CARET_END",
      documentKey,
      blockId: operation.blockId,
      expectedText: operation.oldText,
    });
    await keyPress(tabId, "Enter", "Enter", 13);
    undoUnits += 1;
    await insertText(tabId, operation.newText);
    undoUnits += 1;
    const inserted = await sendContent(tabId, {
      type: "WAIT_FOR_INSERT",
      documentKey,
      anchorId: operation.blockId,
      expectedText: operation.newText,
      timeoutMs: 3_000,
    });
    await verifyKnownBlock(tabId, documentKey, before.next);
    return { undoUnits, insertedId: inserted.id };
  } catch (error) {
    error.undoUnits = (error.undoUnits || 0) + undoUnits;
    throw error;
  }
}

async function applyReplace(tabId, documentKey, operation) {
  let undoUnits = 0;
  try {
    const before = await sendContent(tabId, { type: "GET_BLOCK_STATE", documentKey, blockId: operation.blockId });
    if (!before.exists || before.block.text !== operation.oldText || !before.block.editable) {
      throw new Error(`待替换段落 ${operation.blockId} 已变化`);
    }
    const hunks = diffToHunks(operation.oldText, operation.newText).sort((left, right) => right.start - left.start);
    let expectedText = operation.oldText;
    for (const hunk of hunks) {
      await sendContent(tabId, {
        type: "SELECT_TEXT_RANGE",
        documentKey,
        blockId: operation.blockId,
        expectedText,
        start: hunk.start,
        end: hunk.end,
      });
      await insertText(tabId, hunk.newText);
      undoUnits += 1;
      expectedText = `${expectedText.slice(0, hunk.start)}${hunk.newText}${expectedText.slice(hunk.end)}`;
      await sendContent(tabId, {
        type: "WAIT_FOR_TEXT",
        documentKey,
        blockId: operation.blockId,
        expectedText,
        timeoutMs: 2_500,
      });
    }
    if (expectedText !== operation.newText) throw new Error(`段落 ${operation.blockId} 的差异计算结果不一致`);
    const after = await ensureNeighborsUnchanged(tabId, documentKey, before, operation.blockId);
    if (after.block.text !== operation.newText) throw new Error(`段落 ${operation.blockId} 的最终文字不一致`);
    return { undoUnits };
  } catch (error) {
    error.undoUnits = (error.undoUnits || 0) + undoUnits;
    throw error;
  }
}

async function applyDelete(tabId, documentKey, operation) {
  let undoUnits = 0;
  try {
    const before = await sendContent(tabId, { type: "GET_BLOCK_STATE", documentKey, blockId: operation.blockId });
    if (!before.exists || before.block.text !== operation.oldText || !before.block.canDelete) {
      throw new Error(`待删除段落 ${operation.blockId} 已变化`);
    }
    await sendContent(tabId, {
      type: "SELECT_WHOLE_BLOCK",
      documentKey,
      blockId: operation.blockId,
      expectedText: operation.oldText,
    });
    await keyPress(tabId, "Backspace", "Backspace", 8);
    undoUnits += 1;
    await waitUntilAbsent(tabId, documentKey, operation.blockId);
    await verifyKnownBlock(tabId, documentKey, before.previous);
    await verifyKnownBlock(tabId, documentKey, before.next);
    return { undoUnits };
  } catch (error) {
    error.undoUnits = (error.undoUnits || 0) + undoUnits;
    throw error;
  }
}

function executionOrder(operations, blocks) {
  const indexById = new Map(blocks.map((block, index) => [block.id, index]));
  const inserts = operations.filter((item) => item.op === OPERATION_TYPES.INSERT)
    .sort((left, right) => (indexById.get(right.blockId) ?? 0) - (indexById.get(left.blockId) ?? 0));
  const replaces = operations.filter((item) => item.op === OPERATION_TYPES.REPLACE)
    .sort((left, right) => (indexById.get(left.blockId) ?? 0) - (indexById.get(right.blockId) ?? 0));
  const deletes = operations.filter((item) => item.op === OPERATION_TYPES.DELETE)
    .sort((left, right) => (indexById.get(right.blockId) ?? 0) - (indexById.get(left.blockId) ?? 0));
  return [...inserts, ...replaces, ...deletes];
}

async function rollback(tabId, documentKey, undoUnits, expectedGuardHash) {
  if (!undoUnits) return { restored: true, attempts: 0 };
  await emitProgress("rollback", `写入失败，正在撤销 ${undoUnits} 个输入步骤…`);
  for (let attempt = 1; attempt <= undoUnits; attempt += 1) {
    await keyPress(tabId, "z", "KeyZ", 90, 2);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const state = await sendContent(tabId, { type: "GET_GUARD", documentKey });
    if (state.guardHash === expectedGuardHash) return { restored: true, attempts: attempt };
  }
  return { restored: false, attempts: undoUnits };
}

async function applyOperations(payload) {
  const tab = await activeYuqueTab();
  const { snapshot } = payload;
  const currentTabDocumentKey = tab.url.split(/[?#]/u)[0];
  if (!snapshot || (snapshot.tabDocumentKey || snapshot.documentKey) !== currentTabDocumentKey) {
    throw new Error("当前标签页不是生成建议时的语雀文档");
  }
  const requestShape = {
    sourceHash: snapshot.sourceHash,
    blocks: snapshot.blocks,
  };
  const validated = validateRevisionResponse({
    sourceHash: snapshot.sourceHash,
    summary: "",
    warnings: [],
    operations: payload.operations,
  }, requestShape);
  if (!validated.operations.length) throw new Error("没有选中任何修改项");

  await sendContent(tab.id, { type: "PING_EDITOR" });
  const preflight = await sendContent(tab.id, { type: "GET_GUARD", documentKey: snapshot.documentKey });
  if (preflight.guardHash !== snapshot.guardHash) {
    throw new Error("生成建议后文档已发生变化。请重新读取文档并生成建议");
  }

  await attachDebugger(tab.id);
  let undoUnits = 0;
  const applied = [];
  const insertedIds = [];
  try {
    const ordered = executionOrder(validated.operations, snapshot.blocks);
    for (let index = 0; index < ordered.length; index += 1) {
      const operation = ordered[index];
      await emitProgress("apply", `正在应用 ${index + 1}/${ordered.length}：${operation.reason || operation.op}`);
      let result;
      if (operation.op === OPERATION_TYPES.INSERT) result = await applyInsert(tab.id, snapshot.documentKey, operation);
      else if (operation.op === OPERATION_TYPES.REPLACE) result = await applyReplace(tab.id, snapshot.documentKey, operation);
      else result = await applyDelete(tab.id, snapshot.documentKey, operation);
      undoUnits += result.undoUnits;
      if (result.insertedId) insertedIds.push(result.insertedId);
      applied.push(operation);
    }
  } catch (error) {
    undoUnits += Number(error?.undoUnits || 0);
    const rollbackResult = await rollback(tab.id, snapshot.documentKey, undoUnits, snapshot.guardHash);
    const suffix = rollbackResult.restored
      ? "已自动撤销本批次中完成的修改。"
      : "自动撤销未能恢复原始状态，请立即在语雀中检查并使用 Ctrl+Z。";
    throw new Error(`${error?.message || String(error)} ${suffix}`);
  } finally {
    try { await chrome.debugger.detach({ tabId: tab.id }); } catch { /* 已断开时忽略 */ }
  }

  await emitProgress("save", "修改已写入，正在等待语雀保存…");
  const save = await sendContent(tab.id, {
    type: "WAIT_FOR_SAVE",
    documentKey: snapshot.documentKey,
    timeoutMs: 15_000,
  });
  if (save.saved === false) throw new Error(save.error || "语雀保存失败");
  return {
    appliedCount: applied.length,
    operations: applied,
    insertedIds,
    saved: save.saved,
    warning: save.warning || "",
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "APPLY_PROGRESS") return false;
  const handlers = {
    GET_EDITOR_STATUS: async () => {
      const tab = await activeYuqueTab();
      const frame = await discoverEditorFrame(tab.id, true);
      const status = await sendContent(tab.id, { type: "PING_EDITOR" });
      return { ...status, frame: frame.diagnostic, frameCount: frame.allDiagnostics.length };
    },
    EXTRACT_DOCUMENT: async () => {
      const tab = await activeYuqueTab();
      const frame = await discoverEditorFrame(tab.id, true);
      const snapshot = await sendContent(tab.id, { type: "COLLECT_DOCUMENT", scope: message.scope });
      return {
        ...snapshot,
        title: snapshot.title || tab.title || "",
        tabDocumentKey: tab.url.split(/[?#]/u)[0],
        frameDiagnostic: frame.diagnostic,
        frameCount: frame.allDiagnostics.length,
      };
    },
    APPLY_OPERATIONS: () => applyOperations(message),
  };
  const handler = handlers[message?.type];
  if (!handler) return false;
  Promise.resolve(handler())
    .then((value) => sendResponse({ ok: true, value }))
    .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});
