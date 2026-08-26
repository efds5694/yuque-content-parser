import {
  BRIDGE_DEFAULT_URL,
  OPERATION_TYPES,
  normalizeBridgeUrl,
  validateRevisionRequest,
  validateRevisionResponse,
} from "./lib/protocol.js";

const elements = Object.fromEntries([
  "editorBadge", "settings", "bridgeUrl", "bridgeToken", "pairButton", "bridgeStatus",
  "instruction", "generateButton", "workStatus", "resultSection", "resultTitle", "acceptedCount",
  "summary", "warnings", "acceptAll", "rejectAll", "operations", "applyButton", "logSection", "log",
].map((id) => [id, document.getElementById(id)]));

let revisionState = null;
let busy = false;

function setBadge(text, style = "neutral") {
  elements.editorBadge.textContent = text;
  elements.editorBadge.className = `badge ${style}`;
}

function setStatus(text, style = "") {
  elements.workStatus.textContent = text;
  elements.workStatus.className = `status-line ${style}`.trim();
}

function setBusy(value) {
  busy = value;
  elements.generateButton.disabled = value;
  elements.applyButton.disabled = value || !revisionState;
  elements.pairButton.disabled = value;
}

async function background(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || "扩展后台没有返回结果");
  return response.value;
}

async function settings() {
  const stored = await chrome.storage.local.get(["bridgeUrl", "bridgeToken"]);
  return {
    bridgeUrl: normalizeBridgeUrl(stored.bridgeUrl || BRIDGE_DEFAULT_URL),
    bridgeToken: String(stored.bridgeToken || ""),
  };
}

async function bridgeFetch(path, options = {}, timeoutMs = 12_000) {
  const config = await settings();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${config.bridgeUrl}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(config.bridgeToken ? { Authorization: `Bearer ${config.bridgeToken}` } : {}),
        ...(options.headers || {}),
      },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `本地服务返回 HTTP ${response.status}`);
    return body;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("等待本地服务超时");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function refreshConnections() {
  try {
    const config = await settings();
    elements.bridgeUrl.value = config.bridgeUrl;
    elements.bridgeToken.value = config.bridgeToken;
    const health = await bridgeFetch("/health", { method: "GET" });
    elements.bridgeStatus.textContent = `本地服务已启动 · ${health.version}`;
    if (config.bridgeToken) {
      await bridgeFetch("/v1/pair", { method: "POST", body: "{}" });
      elements.bridgeStatus.textContent = "本地服务已连接，配对码有效。";
    }
  } catch (error) {
    elements.bridgeStatus.textContent = error?.message || String(error);
  }

  try {
    const status = await background({ type: "GET_EDITOR_STATUS" });
    if (status.ready) {
      setBadge(status.frame?.frameId === 0 ? "编辑器就绪" : "编辑器框架就绪", "good");
      elements.editorBadge.title = `框架 ${status.frame?.frameId ?? 0}；${status.diagnostic?.root || "未知根节点"}；Lake ID ${status.diagnostic?.lakeIdCount ?? 0}`;
    }
    else setBadge("请进入编辑", "bad");
  } catch (error) {
    setBadge("未连接语雀", "bad");
    setStatus(error?.message || String(error), "error");
  }
}

async function saveAndPair() {
  if (busy) return;
  try {
    setBusy(true);
    const bridgeUrl = normalizeBridgeUrl(elements.bridgeUrl.value);
    const bridgeToken = elements.bridgeToken.value.trim();
    if (!bridgeToken) throw new Error("请输入 start.cmd 窗口中显示的配对码");
    await chrome.storage.local.set({ bridgeUrl, bridgeToken });
    await bridgeFetch("/v1/pair", { method: "POST", body: "{}" });
    elements.bridgeStatus.textContent = "连接成功，配对码已保存在本机扩展中。";
    elements.settings.open = false;
  } catch (error) {
    elements.bridgeStatus.textContent = error?.message || String(error);
  } finally {
    setBusy(false);
  }
}

function operationName(operation) {
  if (operation.op === OPERATION_TYPES.REPLACE) return "修改段落";
  if (operation.op === OPERATION_TYPES.INSERT) return "创建段落";
  return "删除段落";
}

function appendDiff(container, label, value, className) {
  const row = document.createElement("div");
  row.className = `diff-row ${className}`;
  const prefix = document.createElement("span");
  prefix.className = "diff-label";
  prefix.textContent = label;
  row.append(prefix, document.createTextNode(value || "（空）"));
  container.append(row);
}

function updateAcceptedCount() {
  const boxes = Array.from(elements.operations.querySelectorAll('input[type="checkbox"]'));
  const accepted = boxes.filter((box) => box.checked).length;
  elements.acceptedCount.textContent = `${accepted}/${boxes.length} 项`;
  elements.applyButton.disabled = busy || accepted === 0;
}

function renderRevision(revision) {
  elements.resultSection.classList.remove("hidden");
  elements.resultTitle.textContent = revision.operations.length ? "待确认的修改" : "没有建议修改";
  elements.summary.textContent = revision.summary || "Codex 没有提供摘要。";
  elements.operations.replaceChildren();
  if (revision.warnings.length) {
    elements.warnings.classList.remove("hidden");
    elements.warnings.textContent = revision.warnings.map((item) => `• ${item}`).join("\n");
  } else {
    elements.warnings.classList.add("hidden");
    elements.warnings.textContent = "";
  }

  revision.operations.forEach((operation, index) => {
    const article = document.createElement("article");
    article.className = "operation";
    const head = document.createElement("div");
    head.className = "operation-head";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.dataset.index = String(index);
    checkbox.addEventListener("change", updateAcceptedCount);
    const title = document.createElement("div");
    title.className = "operation-title";
    title.textContent = `${index + 1}. ${operationName(operation)}`;
    head.append(checkbox, title);
    if (operation.factChange) {
      const tag = document.createElement("span");
      tag.className = "fact-tag";
      tag.textContent = "事实变化";
      head.append(tag);
    }
    const reason = document.createElement("p");
    reason.className = "reason";
    reason.textContent = operation.reason || "未提供修改理由";
    const diff = document.createElement("div");
    diff.className = "diff";
    appendDiff(diff, "原", operation.oldText, "diff-old");
    if (operation.op !== OPERATION_TYPES.DELETE) appendDiff(diff, "新", operation.newText, "diff-new");
    article.append(head, reason, diff);
    elements.operations.append(article);
  });
  updateAcceptedCount();
}

async function generateRevision() {
  if (busy) return;
  try {
    setBusy(true);
    revisionState = null;
    elements.resultSection.classList.add("hidden");
    elements.logSection.classList.add("hidden");
    const instruction = elements.instruction.value.trim();
    if (!instruction) throw new Error("请输入修改要求");
    const scope = document.querySelector('input[name="scope"]:checked')?.value || "selection";
    setStatus(scope === "selection" ? "正在读取选中的段落…" : "正在读取整篇文档…");
    const snapshot = await background({ type: "EXTRACT_DOCUMENT", scope });
    if (snapshot.stats.editableCount === 0) {
      const diagnostic = snapshot.diagnostic || {};
      throw new Error(
        `识别到 ${snapshot.stats.blockCount} 个块，但没有可编辑段落。`
        + `编辑器根节点：${diagnostic.root || "未知"}；Lake ID：${diagnostic.lakeIdCount ?? 0}；候选段落：${diagnostic.candidateBlockCount ?? 0}；稳定 ID：${diagnostic.stableIdCount ?? 0}。`
        + "请先在 edge://extensions 重新加载扩展，再刷新语雀页面；若仍出现此信息，请把这些诊断数字发给我。",
      );
    }
    const request = validateRevisionRequest({
      scope,
      instruction,
      title: snapshot.title,
      sourceHash: snapshot.sourceHash,
      blocks: snapshot.blocks,
    });
    setStatus(`已读取 ${snapshot.stats.blockCount} 个块（${snapshot.stats.editableCount} 个可编辑），Codex 正在审阅…`);
    const revision = await bridgeFetch("/v1/revise", {
      method: "POST",
      body: JSON.stringify(request),
    }, 310_000);
    const validated = validateRevisionResponse(revision, request);
    revisionState = { snapshot, request, revision: validated };
    renderRevision(validated);
    setStatus(`审阅完成，共 ${validated.operations.length} 项建议。`, "success");
  } catch (error) {
    revisionState = null;
    setStatus(error?.message || String(error), "error");
  } finally {
    setBusy(false);
    if (revisionState) updateAcceptedCount();
  }
}

function selectAll(value) {
  for (const checkbox of elements.operations.querySelectorAll('input[type="checkbox"]')) checkbox.checked = value;
  updateAcceptedCount();
}

async function applyRevision() {
  if (busy || !revisionState) return;
  const acceptedIndexes = Array.from(elements.operations.querySelectorAll('input[type="checkbox"]:checked'))
    .map((checkbox) => Number(checkbox.dataset.index));
  const operations = acceptedIndexes.map((index) => revisionState.revision.operations[index]).filter(Boolean);
  if (!operations.length) return;
  try {
    setBusy(true);
    elements.logSection.classList.remove("hidden");
    elements.log.textContent = `准备应用 ${operations.length} 项修改…`;
    const result = await background({
      type: "APPLY_OPERATIONS",
      snapshot: revisionState.snapshot,
      operations,
    });
    const saveMessage = result.saved === true ? "语雀已显示保存完成。" : result.warning;
    elements.log.textContent = `成功应用 ${result.appliedCount} 项修改。\n${saveMessage || ""}`.trim();
    setStatus("修改已写入原文档。刷新前请留意语雀保存状态。", "success");
    revisionState = null;
    elements.applyButton.disabled = true;
  } catch (error) {
    elements.log.textContent = error?.message || String(error);
    setStatus("应用失败，详情见操作结果。", "error");
  } finally {
    setBusy(false);
    if (revisionState) updateAcceptedCount();
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "APPLY_PROGRESS") return;
  elements.logSection.classList.remove("hidden");
  elements.log.textContent = message.detail || message.stage;
});

elements.pairButton.addEventListener("click", saveAndPair);
elements.generateButton.addEventListener("click", generateRevision);
elements.acceptAll.addEventListener("click", () => selectAll(true));
elements.rejectAll.addEventListener("click", () => selectAll(false));
elements.applyButton.addEventListener("click", applyRevision);

refreshConnections();
