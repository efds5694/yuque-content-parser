(() => {
  "use strict";

  if (globalThis.__yuqueContentParserLoaded) return;
  globalThis.__yuqueContentParserLoaded = true;

  const ROOT_SELECTORS = [
    ".ne-engine", ".lake-engine", ".lake-content-editor-core", ".lake-content",
    "[data-lake-editor]", "#doc-reader-content article", "#doc-reader-content", '[contenteditable="true"]',
  ];
  const UNIT_SELECTOR = [
    "p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "blockquote", "table", "details", "pre", "hr", "card",
    "ne-p", "ne-h1", "ne-h2", "ne-h3", "ne-h4", "ne-h5", "ne-h6", "ne-tli", "ne-table", "ne-codeblock",
    "ne-collapse", "ne-alert", "ne-alert-hole", "ne-hole", "ne-card", '[ne-role="render-unit"]',
  ].join(",");
  const parserPromise = import(chrome.runtime.getURL("lib/parser.js"));
  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  let capturedSelection = null;

  function documentKey() {
    return location.href.split(/[?#]/u)[0];
  }

  function pageTitle() {
    return document.title.replace(/\s*[·\-–—|]\s*语雀.*$/u, "").trim() || "未命名语雀文档";
  }

  function isVisible(element) {
    if (!element?.isConnected) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  function rootScore(element) {
    const units = element.querySelectorAll(UNIT_SELECTOR).length;
    const stableIds = element.querySelectorAll("[id],[data-lake-id]").length;
    const textLength = (element.textContent || "").trim().length;
    const editorBonus = element.matches(".ne-engine,.lake-engine,[data-lake-editor]") ? 500 : 0;
    return units * 40 + Math.min(stableIds, 500) * 2 + Math.min(textLength, 20_000) / 20 + editorBonus;
  }

  function findDocumentRoot() {
    const candidates = [];
    for (const selector of ROOT_SELECTORS) {
      for (const element of document.querySelectorAll(selector)) {
        if (isVisible(element) && !candidates.includes(element)) candidates.push(element);
      }
    }
    return candidates.sort((left, right) => rootScore(right) - rootScore(left))[0] || null;
  }

  function describeRoot(root) {
    if (!root) return "未找到";
    const classes = typeof root.className === "string" ? root.className.trim().split(/\s+/u).slice(0, 3).join(".") : "";
    return `${root.tagName.toLocaleLowerCase("en-US")}${root.id ? `#${root.id}` : ""}${classes ? `.${classes}` : ""}`;
  }

  function selectionBlock(element, root) {
    const match = element?.closest?.(UNIT_SELECTOR);
    return match && root.contains(match) ? match : null;
  }

  function wrapSelectionFragment(range, fragment, root) {
    const common = range.commonAncestorContainer.nodeType === 1
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
    const block = selectionBlock(common, root);
    if (!block || common === root) return fragment;
    const chain = [];
    for (let element = common; element && root.contains(element); element = element.parentElement) {
      chain.push(element);
      if (element === block) break;
    }
    let wrapped = fragment;
    for (const element of chain) {
      const clone = element.cloneNode(false);
      clone.removeAttribute?.("contenteditable");
      clone.append(wrapped);
      const next = document.createDocumentFragment();
      next.append(clone);
      wrapped = next;
    }
    return wrapped;
  }

  function fragmentHtml(fragment) {
    const container = document.createElement("div");
    container.append(fragment);
    return container.innerHTML;
  }

  function captureSelection() {
    const root = findDocumentRoot();
    const selection = window.getSelection();
    if (!root || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
      capturedSelection = null;
      return { count: 0, characters: 0, documentKey: documentKey() };
    }
    const range = selection.getRangeAt(0);
    try {
      if (!range.intersectsNode(root)) {
        capturedSelection = null;
        return { count: 0, characters: 0, documentKey: documentKey() };
      }
    } catch {
      capturedSelection = null;
      return { count: 0, characters: 0, documentKey: documentKey() };
    }
    const selectedText = selection.toString();
    const html = fragmentHtml(wrapSelectionFragment(range, range.cloneContents(), root));
    const probe = document.createElement("div");
    probe.innerHTML = html;
    const count = Math.max(1, probe.querySelectorAll(UNIT_SELECTOR).length);
    capturedSelection = { documentKey: documentKey(), html, text: selectedText, count, title: pageTitle(), url: location.href };
    return { count, characters: selectedText.length, documentKey: capturedSelection.documentKey };
  }

  function findScrollContainer(root) {
    for (let element = root; element; element = element.parentElement) {
      const style = getComputedStyle(element);
      if (/(auto|scroll)/u.test(style.overflowY) && element.scrollHeight > element.clientHeight + 20) return element;
    }
    return document.scrollingElement || document.documentElement;
  }

  function isDocumentScroller(scroller) {
    return scroller === document.scrollingElement || scroller === document.documentElement || scroller === document.body;
  }

  function scrollTopOf(scroller) {
    return isDocumentScroller(scroller) ? window.scrollY : scroller.scrollTop;
  }

  function setScrollTop(scroller, top) {
    if (isDocumentScroller(scroller)) window.scrollTo({ top, behavior: "auto" });
    else scroller.scrollTo({ top, behavior: "auto" });
  }

  function scrollHeightOf(scroller) {
    return isDocumentScroller(scroller) ? document.documentElement.scrollHeight : scroller.scrollHeight;
  }

  function clientHeightOf(scroller) {
    return isDocumentScroller(scroller) ? window.innerHeight : scroller.clientHeight;
  }

  function topLevelUnits(root) {
    const direct = Array.from(root.children).filter((element) => element.matches(UNIT_SELECTOR));
    if (direct.length) return direct;
    return Array.from(root.querySelectorAll(UNIT_SELECTOR)).filter((element) => {
      const parentUnit = element.parentElement?.closest(UNIT_SELECTOR);
      return !parentUnit || !root.contains(parentUnit);
    });
  }

  function unitKey(element, position, sequence) {
    const stableId = element.getAttribute("data-lake-id") || element.id;
    if (stableId) return `id:${stableId}`;
    const text = (element.textContent || "").replace(/\s+/gu, " ").trim().slice(0, 80);
    return `fallback:${element.tagName}:${Math.round(position)}:${text || sequence}`;
  }

  function saveSelectionRange() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    try { return selection.getRangeAt(0).cloneRange(); } catch { return null; }
  }

  function restoreSelectionRange(range) {
    if (!range || !range.startContainer?.isConnected || !range.endContainer?.isConnected) return;
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  async function scanWholeDocument(root) {
    const scroller = findScrollContainer(root);
    const originalTop = scrollTopOf(scroller);
    const originalRange = saveSelectionRange();
    const collected = new Map();
    let sequence = 0;
    let previousTop = -1;
    let stableEndPasses = 0;
    try {
      setScrollTop(scroller, 0);
      await sleep(80);
      for (let pass = 0; pass < 300; pass += 1) {
        const currentTop = scrollTopOf(scroller);
        const containerTop = isDocumentScroller(scroller) ? 0 : scroller.getBoundingClientRect().top;
        for (const unit of topLevelUnits(root)) {
          const position = currentTop + unit.getBoundingClientRect().top - containerTop;
          const key = unitKey(unit, position, sequence);
          const existing = collected.get(key);
          if (!existing || position < existing.position) collected.set(key, { position, sequence: sequence++, html: unit.outerHTML });
        }
        const maxTop = Math.max(0, scrollHeightOf(scroller) - clientHeightOf(scroller));
        if (currentTop >= maxTop - 2) {
          stableEndPasses += 1;
          if (stableEndPasses >= 2) break;
        } else stableEndPasses = 0;
        if (currentTop === previousTop && currentTop < maxTop - 2) break;
        previousTop = currentTop;
        const step = Math.max(280, clientHeightOf(scroller) * 0.78);
        setScrollTop(scroller, Math.min(maxTop, currentTop + step));
        await sleep(65);
      }
    } finally {
      setScrollTop(scroller, originalTop);
      await sleep(30);
      restoreSelectionRange(originalRange);
    }
    return Array.from(collected.values())
      .sort((left, right) => left.position - right.position || left.sequence - right.sequence)
      .map((entry) => entry.html)
      .join("");
  }

  async function parsePage(scope) {
    const root = findDocumentRoot();
    if (!root) throw new Error("没有检测到语雀正文，请刷新页面后重试");
    const parser = await parserPromise;
    if (scope === "selection") {
      if (!capturedSelection || capturedSelection.documentKey !== documentKey() || !capturedSelection.html) {
        throw new Error("请先在语雀正文中选择内容，再点击右下角“析”按钮");
      }
      return parser.parsePageHtml(capturedSelection.html, { title: capturedSelection.title, url: capturedSelection.url, scope: "selection" });
    }
    chrome.runtime.sendMessage({ type: "PARSE_PROGRESS", stage: "scan", detail: "正在滚动扫描整篇语雀文档…" }).catch(() => {});
    const html = await scanWholeDocument(root);
    return parser.parsePageHtml(html, { title: pageTitle(), url: location.href, scope: "document" });
  }

  function pageStatus() {
    const root = findDocumentRoot();
    return {
      ready: Boolean(root),
      documentKey: documentKey(),
      title: pageTitle(),
      selectionCount: capturedSelection?.documentKey === documentKey() ? capturedSelection.count : 0,
      selectionCharacters: capturedSelection?.documentKey === documentKey() ? capturedSelection.text.length : 0,
      diagnostic: {
        root: describeRoot(root),
        unitCount: root ? root.querySelectorAll(UNIT_SELECTOR).length : 0,
        editable: Boolean(root?.matches('[contenteditable="true"]') || root?.querySelector('[contenteditable="true"]')),
      },
    };
  }

  const handlers = {
    GET_PAGE_STATUS: () => pageStatus(),
    CAPTURE_SELECTION: () => captureSelection(),
    PARSE_PAGE: (message) => parsePage(message.scope === "selection" ? "selection" : "document"),
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const handler = handlers[message?.type];
    if (!handler) return false;
    Promise.resolve(handler(message))
      .then((value) => sendResponse({ ok: true, value }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  });
})();
