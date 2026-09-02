import { MAX_LAKE_BYTES, parseLake } from "./lib/parser.js";
import { safeFilename, serializeHtml, serializeJson, serializeMarkdown } from "./lib/serializers.js";

const elements = Object.fromEntries([
  "pageBadge", "closeButton", "sourceAuto", "sourcePage", "sourceLake", "autoControls", "pageControls", "lakeControls", "selectionHint",
  "lakeFile", "fileHint", "parseButton", "workStatus", "resultSection", "resultTitle", "fidelityBadge",
  "stats", "diagnosticsBox", "diagnosticsSummary", "diagnostics", "textPreview", "htmlPreview",
  "copyButton", "downloadButton",
].map((id) => [id, document.getElementById(id)]));

const formats = {
  markdown: { label: "Markdown", extension: "md", mime: "text/markdown;charset=utf-8" },
  html: { label: "富文本", extension: "html", mime: "text/html;charset=utf-8" },
  json: { label: "JSON", extension: "json", mime: "application/json;charset=utf-8" },
};

let busy = false;
let parseResult = null;
let outputs = null;
let activeFormat = "markdown";

async function background(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || "扩展后台没有返回结果");
  return response.value;
}

function setStatus(message, style = "") {
  elements.workStatus.textContent = message;
  elements.workStatus.className = `status-line ${style}`.trim();
}

function setBusy(value) {
  busy = value;
  elements.parseButton.disabled = value;
  elements.copyButton.disabled = value || !parseResult;
  elements.downloadButton.disabled = value || !parseResult;
}

function selectedSource() {
  return document.querySelector('input[name="source"]:checked')?.value || "page";
}

function selectedScope() {
  return document.querySelector('input[name="scope"]:checked')?.value || "selection";
}

function clearResult() {
  parseResult = null;
  outputs = null;
  elements.resultSection.classList.add("hidden");
  elements.textPreview.textContent = "";
  elements.htmlPreview.srcdoc = "";
}

function updateParseButton() {
  const source = selectedSource();
  if (source === "current-lake") elements.parseButton.textContent = "一键解析当前文档";
  else if (source === "lake") elements.parseButton.textContent = "解析 .lake 文件";
  else elements.parseButton.textContent = selectedScope() === "selection" ? "解析当前选区" : "扫描整篇文档";
}

function updateSourceControls() {
  const source = selectedSource();
  elements.autoControls.classList.toggle("hidden", source !== "current-lake");
  elements.pageControls.classList.toggle("hidden", source !== "page");
  elements.lakeControls.classList.toggle("hidden", source !== "lake");
  updateParseButton();
  clearResult();
  setStatus("");
}

function renderStats(stats) {
  const entries = [
    [stats.nodes || 0, "节点"],
    [stats.characters || 0, "字符"],
    [stats.images || 0, "图片"],
    [stats.warnings || 0, "提示"],
  ];
  elements.stats.replaceChildren(...entries.map(([value, label]) => {
    const item = document.createElement("div");
    item.className = "stat";
    const strong = document.createElement("strong");
    strong.textContent = Number(value).toLocaleString("zh-CN");
    const span = document.createElement("span");
    span.textContent = label;
    item.append(strong, span);
    return item;
  }));
}

function renderDiagnostics(diagnostics) {
  elements.diagnostics.replaceChildren();
  elements.diagnosticsBox.classList.toggle("hidden", diagnostics.length === 0);
  elements.diagnosticsSummary.textContent = diagnostics.length ? `${diagnostics.length} 条解析提示` : "没有解析提示";
  for (const entry of diagnostics) {
    const item = document.createElement("li");
    item.textContent = entry.message;
    elements.diagnostics.append(item);
  }
  elements.diagnosticsBox.open = diagnostics.some((entry) => entry.severity === "error");
}

function outputText(format) {
  if (!outputs) return "";
  if (format === "html") return outputs.htmlStandalone;
  return outputs[format];
}

function showFormat(format) {
  activeFormat = format;
  for (const tab of document.querySelectorAll(".tab")) {
    const active = tab.dataset.format === format;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  }
  const html = format === "html";
  elements.textPreview.classList.toggle("hidden", html);
  elements.htmlPreview.classList.toggle("hidden", !html);
  if (html) elements.htmlPreview.srcdoc = outputs?.htmlPreview || "";
  else elements.textPreview.textContent = outputText(format);
  elements.copyButton.textContent = `复制${format === "html" ? "富文本" : ` ${formats[format].label}`}`;
  elements.downloadButton.textContent = `下载 .${formats[format].extension}`;
}

function renderResult(result) {
  parseResult = result;
  outputs = {
    markdown: serializeMarkdown(result),
    htmlFragment: serializeHtml(result, { standalone: false }),
    htmlStandalone: serializeHtml(result),
    htmlPreview: serializeHtml(result, { blockNetwork: true }),
    json: serializeJson(result),
  };
  elements.resultSection.classList.remove("hidden");
  elements.resultTitle.textContent = result.document.title;
  const sourceFidelity = result.document.source.fidelity === "source";
  elements.fidelityBadge.textContent = sourceFidelity ? "Lake 高保真" : "页面尽力提取";
  elements.fidelityBadge.className = `badge ${sourceFidelity ? "good" : "warn"}`;
  renderStats(result.stats);
  renderDiagnostics(result.diagnostics);
  showFormat(activeFormat);
  setStatus(`解析完成：${result.stats.nodes} 个语义节点。`, "success");
}

async function parseSelectedSource() {
  if (busy) return;
  try {
    setBusy(true);
    clearResult();
    let result;
    if (selectedSource() === "current-lake") {
      setStatus("正在读取当前文档的 Lake 源内容…");
      const current = await background({ type: "GET_CURRENT_LAKE" });
      result = parseLake(current.lake, {
        title: current.title,
        url: current.url,
        fileName: `${current.title || "语雀文档"}.lake`,
      });
    } else if (selectedSource() === "lake") {
      const file = elements.lakeFile.files?.[0];
      if (!file) throw new Error("请先选择一个 .lake 文件");
      if (file.size > MAX_LAKE_BYTES) throw new Error(".lake 文件不能超过 20 MiB");
      setStatus("正在本地读取并解析 .lake 文件…");
      result = parseLake(await file.text(), { fileName: file.name });
    } else {
      const scope = selectedScope();
      setStatus(scope === "selection" ? "正在解析精确选区…" : "正在滚动扫描整篇文档…");
      result = await background({ type: "PARSE_PAGE", scope });
    }
    renderResult(result);
  } catch (error) {
    setStatus(error?.message || String(error), "error");
  } finally {
    setBusy(false);
  }
}

function fallbackCopyText(value) {
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.cssText = "position:fixed;opacity:0;pointer-events:none";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("浏览器拒绝写入剪贴板");
}

function fallbackCopyHtml(html, plainText) {
  const container = document.createElement("div");
  container.contentEditable = "true";
  container.style.cssText = "position:fixed;left:-9999px;top:0";
  container.innerHTML = html;
  document.body.append(container);
  const range = document.createRange();
  range.selectNodeContents(container);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  const onCopy = (event) => {
    event.clipboardData?.setData("text/html", html);
    event.clipboardData?.setData("text/plain", plainText);
    event.preventDefault();
  };
  document.addEventListener("copy", onCopy, true);
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } finally {
    document.removeEventListener("copy", onCopy, true);
    selection.removeAllRanges();
    container.remove();
  }
  if (!copied) throw new Error("浏览器拒绝写入富文本剪贴板");
}

async function copyCurrent() {
  if (!outputs || busy) return;
  try {
    if (activeFormat === "html") {
      let copied = false;
      if (navigator.clipboard?.write && typeof ClipboardItem === "function") {
        try {
          const item = new ClipboardItem({
            "text/html": new Blob([outputs.htmlFragment], { type: "text/html" }),
            "text/plain": new Blob([outputs.markdown], { type: "text/plain" }),
          });
          await navigator.clipboard.write([item]);
          copied = true;
        } catch {
          // 语雀页面可能通过 Permissions Policy 禁止 iframe 使用 Clipboard API。
        }
      }
      if (!copied) fallbackCopyHtml(outputs.htmlFragment, outputs.markdown);
    } else {
      const text = outputText(activeFormat);
      let copied = false;
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(text);
          copied = true;
        } catch {
          // 被宿主页面策略拒绝时，退回同步复制命令。
        }
      }
      if (!copied) fallbackCopyText(text);
    }
    setStatus(`${formats[activeFormat].label} 已复制到剪贴板。`, "success");
  } catch (error) {
    setStatus(error?.message || String(error), "error");
  }
}

function downloadCurrent() {
  if (!outputs || !parseResult || busy) return;
  const format = formats[activeFormat];
  const suffix = parseResult.document.source.scope === "selection" ? "-选区" : "";
  const filename = `${safeFilename(parseResult.document.title)}${suffix}.${format.extension}`;
  const blob = new Blob([outputText(activeFormat)], { type: format.mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
  setStatus(`已生成 ${filename}。`, "success");
}

async function refreshPageStatus() {
  try {
    const status = await background({ type: "GET_PAGE_STATUS" });
    elements.pageBadge.textContent = status.ready ? "页面可读" : "未找到正文";
    elements.pageBadge.className = `badge ${status.ready ? "good" : "bad"}`;
    elements.pageBadge.title = `${status.diagnostic?.root || "未知根节点"} · ${status.diagnostic?.unitCount || 0} 个候选节点`;
    elements.selectionHint.textContent = status.selectionCount
      ? `已捕获 ${status.selectionCharacters} 个字符，覆盖 ${status.selectionCount} 个结构`
      : "打开工具前先在正文中选择内容";
  } catch (error) {
    elements.pageBadge.textContent = "未连接页面";
    elements.pageBadge.className = "badge bad";
    elements.pageBadge.title = error?.message || String(error);
  }
}

elements.closeButton.addEventListener("click", () => background({ type: "TOGGLE_INLINE_PANEL", open: false }).catch(() => {}));
for (const input of document.querySelectorAll('input[name="source"]')) input.addEventListener("change", updateSourceControls);
for (const input of document.querySelectorAll('input[name="scope"]')) input.addEventListener("change", () => { updateParseButton(); clearResult(); setStatus(""); });
elements.lakeFile.addEventListener("change", () => {
  const file = elements.lakeFile.files?.[0];
  elements.sourceLake.checked = true;
  updateSourceControls();
  elements.fileHint.textContent = file
    ? `${file.name} · ${(file.size / 1024).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} KiB`
    : "单个文件不超过 20 MiB；文件仅在本机浏览器中解析。";
});
elements.parseButton.addEventListener("click", parseSelectedSource);
elements.copyButton.addEventListener("click", copyCurrent);
elements.downloadButton.addEventListener("click", downloadCurrent);
for (const tab of document.querySelectorAll(".tab")) tab.addEventListener("click", () => showFormat(tab.dataset.format));
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "PARSE_PROGRESS" && busy) setStatus(message.detail || "正在扫描页面…");
});

updateSourceControls();
refreshPageStatus();
