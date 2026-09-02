const frameCache = new Map();

function isYuqueUrl(value) {
  try {
    const url = new URL(value || "");
    return url.protocol === "https:" && (url.hostname === "yuque.com" || url.hostname.endsWith(".yuque.com"));
  } catch {
    return false;
  }
}

async function activeYuqueTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !isYuqueUrl(tab.url)) throw new Error("请先打开需要读取的语雀文档");
  return tab;
}

function probePageDocument() {
  const unitSelector = [
    "p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "blockquote", "table", "details", "pre", "card",
    "ne-p", "ne-h1", "ne-h2", "ne-h3", "ne-h4", "ne-h5", "ne-h6", "ne-tli", "ne-table", "ne-codeblock",
    "ne-collapse", "ne-alert", "ne-card", '[ne-role="render-unit"]',
  ].join(",");
  const selectors = [
    ".ne-engine", ".lake-engine", ".lake-content-editor-core", ".lake-content", "[data-lake-editor]",
    "#doc-reader-content article", "#doc-reader-content", '[contenteditable="true"]',
  ];
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  };
  const candidates = [];
  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      if (visible(element) && !candidates.includes(element)) candidates.push(element);
    }
  }
  const ranked = candidates.map((element) => {
    const units = element.querySelectorAll(unitSelector).length;
    const stableIds = element.querySelectorAll("[id],[data-lake-id]").length;
    const textLength = (element.textContent || "").trim().length;
    const preferred = element.matches(".ne-engine,.lake-engine,[data-lake-editor]");
    return {
      score: units * 40 + Math.min(stableIds, 500) * 2 + Math.min(textLength, 20_000) / 20 + (preferred ? 500 : 0),
      units,
      textLength,
      editable: Boolean(element.matches('[contenteditable="true"]') || element.querySelector('[contenteditable="true"]')),
      root: `${element.tagName.toLocaleLowerCase("en-US")}${element.id ? `#${element.id}` : ""}`,
    };
  }).sort((left, right) => right.score - left.score);
  return { href: location.href, title: document.title, best: ranked[0] || null, candidateCount: candidates.length };
}

async function discoverContentFrame(tabId, force = false) {
  if (!force && frameCache.has(tabId)) return frameCache.get(tabId);
  const results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: probePageDocument });
  const probes = results
    .filter((entry) => entry.result)
    .map((entry) => ({ frameId: entry.frameId, ...entry.result }))
    .sort((left, right) => (right.best?.score || 0) - (left.best?.score || 0));
  const selected = probes.find((probe) => probe.best?.score > 0) || probes.find((probe) => probe.frameId === 0);
  if (!selected) throw new Error("无法访问语雀页面，请重新加载扩展和文档页面");
  const context = { frameId: selected.frameId, diagnostic: selected, frameCount: probes.length };
  frameCache.set(tabId, context);
  return context;
}

async function sendContent(tabId, message, retry = true) {
  const frame = await discoverContentFrame(tabId);
  try {
    const response = await chrome.tabs.sendMessage(tabId, message, { frameId: frame.frameId });
    if (!response?.ok) throw new Error(response?.error || "语雀页面没有返回结果");
    return response.value;
  } catch (error) {
    const detail = error?.message || String(error);
    if (retry && /(Receiving end does not exist|Could not establish connection)/iu.test(detail)) {
      await chrome.scripting.executeScript({ target: { tabId, frameIds: [frame.frameId] }, files: ["content.js"] });
      return sendContent(tabId, message, false);
    }
    if (retry && /没有检测到语雀正文/u.test(detail)) {
      frameCache.delete(tabId);
      await discoverContentFrame(tabId, true);
      return sendContent(tabId, message, false);
    }
    throw error;
  }
}

async function tabForSender(sender) {
  if (sender?.tab?.id && isYuqueUrl(sender.tab.url)) return sender.tab;
  return activeYuqueTab();
}

async function readCurrentLakeFromPage() {
  const appData = globalThis.appData;
  const book = appData?.book;
  const currentDoc = appData?.doc;
  const pathParts = location.pathname.split("/").filter(Boolean);
  while (["edit", "reader"].includes(pathParts.at(-1)?.toLocaleLowerCase("en-US"))) pathParts.pop();
  const locationSlug = pathParts.at(-1) || "";
  const slug = locationSlug || currentDoc?.slug || "";
  const bookId = Number(book?.id || currentDoc?.book_id);
  if (!Number.isSafeInteger(bookId) || bookId <= 0 || !slug) {
    throw new Error("没有从当前页面识别出语雀文档信息，请刷新文档后重试");
  }

  const tocEntry = Array.isArray(book?.toc) ? book.toc.find((item) => item?.url === slug || item?.slug === slug) : null;
  const initialTitle = tocEntry?.title || (currentDoc?.slug === slug ? currentDoc?.title : "") || document.title || "语雀文档";
  const query = new URLSearchParams({ book_id: String(bookId), merge_dynamic_data: "false" });
  const response = await globalThis.fetch(`/api/docs/${encodeURIComponent(slug)}?${query}`, {
    method: "GET",
    credentials: "include",
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error("语雀拒绝读取源内容，请确认当前文档已登录且你有导出权限");
    }
    throw new Error(`语雀源内容读取失败（HTTP ${response.status}）`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("语雀返回了无法识别的源内容响应");
  }
  const data = payload?.data || payload;
  const candidates = [data?.content, data?.body_lake, data?.bodyLake, data?.body];
  const lake = candidates.find((value) => typeof value === "string" && /^\s*<!doctype\s+lake\b/iu.test(value))
    || candidates.find((value) => typeof value === "string" && /<(?:card|ne-[a-z\d-]+|p|h[1-6]|table)\b/iu.test(value));
  if (!lake) throw new Error("语雀响应中没有 Lake 正文；可改用“导入 .lake 文件”");

  return {
    lake,
    title: data?.title || initialTitle,
    url: (currentDoc?.slug === slug && appData?.docUrl) || `${location.origin}${location.pathname}`,
  };
}

async function getCurrentLake(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    world: "MAIN",
    func: readCurrentLakeFromPage,
  });
  const current = results[0]?.result;
  if (!current?.lake) throw new Error("当前语雀页面没有返回 Lake 源内容");
  const bytes = new TextEncoder().encode(current.lake).byteLength;
  if (bytes > 20 * 1024 * 1024) throw new Error("当前文档的 Lake 源内容超过 20 MiB 上限");
  return current;
}

async function setInlinePanel(tabId, open, retry = true) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "INLINE_PANEL_SET", open }, { frameId: 0 });
    if (!response?.ok) throw new Error(response?.error || "页内抽屉没有返回结果");
    return response.value;
  } catch (error) {
    const detail = error?.message || String(error);
    if (retry && /(Receiving end does not exist|Could not establish connection)/iu.test(detail)) {
      await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ["inline-ui.js"] });
      return setInlinePanel(tabId, open, false);
    }
    throw error;
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id || !isYuqueUrl(tab.url)) return;
  try { await sendContent(tab.id, { type: "CAPTURE_SELECTION" }); } catch { /* 没有选区仍可读取全文。 */ }
  try { await setInlinePanel(tab.id); } catch { /* 页面刷新后可再次打开。 */ }
});

chrome.tabs.onRemoved.addListener((tabId) => frameCache.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" || changeInfo.url) frameCache.delete(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "PARSE_PROGRESS") return false;
  const handlers = {
    GET_PAGE_STATUS: async () => {
      const tab = await tabForSender(sender);
      const frame = await discoverContentFrame(tab.id, true);
      const status = await sendContent(tab.id, { type: "GET_PAGE_STATUS" });
      return { ...status, tabId: tab.id, frame: frame.diagnostic, frameCount: frame.frameCount };
    },
    CAPTURE_SELECTION: async () => {
      const tab = await tabForSender(sender);
      return sendContent(tab.id, { type: "CAPTURE_SELECTION" });
    },
    PARSE_PAGE: async () => {
      const tab = await tabForSender(sender);
      return sendContent(tab.id, { type: "PARSE_PAGE", scope: message.scope === "selection" ? "selection" : "document" });
    },
    GET_CURRENT_LAKE: async () => {
      const tab = await tabForSender(sender);
      return getCurrentLake(tab.id);
    },
    TOGGLE_INLINE_PANEL: async () => {
      const tab = await tabForSender(sender);
      return setInlinePanel(tab.id, typeof message.open === "boolean" ? message.open : undefined);
    },
    INLINE_DOCUMENT_CHANGED: async () => {
      const tab = await tabForSender(sender);
      frameCache.delete(tab.id);
      return true;
    },
  };
  const handler = handlers[message?.type];
  if (!handler) return false;
  Promise.resolve(handler())
    .then((value) => sendResponse({ ok: true, value }))
    .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});
