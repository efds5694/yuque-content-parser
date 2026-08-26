(() => {
  "use strict";

  const BLOCK_SELECTOR = [
    "p", "h1", "h2", "h3", "h4", "h5", "h6", "li",
    "ne-p", "ne-h1", "ne-h2", "ne-h3", "ne-h4", "ne-h5", "ne-h6",
    "ne-tli", "ne-oli-i", "ne-uli-i",
    ".ne-p", ".ne-heading", ".ne-list-item", ".lake-p", ".lake-heading", ".lake-list-item",
    '[data-node-type="paragraph"]', '[data-node-type="heading"]', '[data-node-type="list_item"]',
    '[data-type="paragraph"]', '[data-type="heading"]', '[data-type="list_item"]',
  ].join(",");
  const PROTECTED_SELECTOR = "table,card,pre,details,ne-card,ne-table,ne-codeblock,ne-collapse";
  const CUSTOM_LIST_ITEM_SELECTOR = "ne-tli,ne-oli-i,ne-uli-i";
  const FILLER_SELECTOR = "[ne-filler],.ne-viewer-b-filler,.ne-b-filler";
  const ALLOWED_INLINE_TAGS = new Set(["SPAN", "STRONG", "EM", "B", "I", "U", "S", "DEL", "MARK", "BR", "NE-TEXT"]);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function documentKey() {
    return location.href.split(/[?#]/u)[0];
  }

  function isVisible(element) {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  function findEditorRoot() {
    const explicit = Array.from(document.querySelectorAll('[contenteditable="true"]'))
      .filter((element) => isVisible(element));
    let winner = null;
    let bestScore = -1;
    for (const candidate of explicit) {
      const score = candidate.querySelectorAll("[data-lake-id]").length * 10
        + candidate.querySelectorAll(BLOCK_SELECTOR).length;
      if (score > bestScore) {
        winner = candidate;
        bestScore = score;
      }
    }
    if (winner && bestScore > 0) return winner;

    const lakeCandidates = Array.from(document.querySelectorAll(".lake-engine,.lake-content,[class*='lake-editor']"));
    for (const candidate of lakeCandidates) {
      const editable = candidate.matches('[contenteditable="true"]')
        || candidate.querySelector('[contenteditable="true"]');
      const score = candidate.querySelectorAll("[data-lake-id]").length;
      if (editable && isVisible(candidate) && score > bestScore) {
        winner = candidate;
        bestScore = score;
      }
    }
    return winner;
  }

  function lakeIdFor(element) {
    return element.getAttribute("data-lake-id")
      || element.id
      || element.querySelector("[data-lake-id]")?.getAttribute("data-lake-id")
      || element.querySelector("[id]")?.id
      || "";
  }

  function closestWithin(element, selector, root) {
    const match = element.closest(selector);
    return match && root.contains(match) ? match : null;
  }

  function textBlockKind(element, root) {
    if (closestWithin(element, "blockquote,ne-alert,ne-quote", root)) return "quote";
    if (closestWithin(element, CUSTOM_LIST_ITEM_SELECTOR, root)) return "list_item";
    const declaredType = element.getAttribute("data-node-type") || element.getAttribute("data-type") || "";
    if (/^(H|NE-H)[1-6]$/u.test(element.tagName)
      || declaredType === "heading"
      || element.classList.contains("ne-heading")
      || element.classList.contains("lake-heading")) return "heading";
    if (element.tagName === "LI"
      || element.matches(CUSTOM_LIST_ITEM_SELECTOR)
      || declaredType === "list_item"
      || element.classList.contains("ne-list-item")
      || element.classList.contains("lake-list-item")) return "list_item";
    return "paragraph";
  }

  function protectedKind(element) {
    if (element.tagName === "TABLE" || element.tagName === "NE-TABLE") return "table";
    if (element.tagName === "CARD" || element.tagName === "NE-CARD") {
      return `card:${element.getAttribute("name") || element.getAttribute("data-card-name") || "unknown"}`;
    }
    if (element.tagName === "DETAILS" || element.tagName === "NE-COLLAPSE") return "details";
    return "code";
  }

  function textElementFor(element) {
    if (/^NE-H[1-6]$/u.test(element.tagName)) {
      return element.querySelector(":scope > ne-heading-content") || element;
    }
    if (element.tagName === "NE-TLI") {
      return element.querySelector(":scope > ne-uli-c,:scope > ne-oli-c") || element;
    }
    return element;
  }

  function hasUnsupportedInline(element) {
    if (element.querySelector("a,card,code,table,pre,details,ne-card,ne-code,ne-link,ne-table,ne-codeblock,ne-collapse")) return true;
    if (Array.from(element.querySelectorAll("br")).some((br) => !br.closest(FILLER_SELECTOR))) return true;
    return Array.from(element.querySelectorAll("*")).some((child) => {
      if (child.matches(FILLER_SELECTOR)) return false;
      return !ALLOWED_INLINE_TAGS.has(child.tagName);
    });
  }

  function buildBlockRecords(root) {
    const protectedNodes = Array.from(root.querySelectorAll(PROTECTED_SELECTOR)).filter((element) => {
      const parentProtected = element.parentElement?.closest(PROTECTED_SELECTOR);
      const parentTextBlock = element.parentElement?.closest(BLOCK_SELECTOR);
      return (!parentProtected || !root.contains(parentProtected))
        && (!parentTextBlock || !root.contains(parentTextBlock));
    });
    const textNodes = Array.from(root.querySelectorAll(BLOCK_SELECTOR)).filter((element) => {
      if (closestWithin(element, PROTECTED_SELECTOR, root)) return false;
      if (element.tagName === "P" && closestWithin(element, "li", root)) return false;
      if (element.matches("ne-oli-i,ne-uli-i") && closestWithin(element, "ne-tli", root)) return false;
      if (element.matches(CUSTOM_LIST_ITEM_SELECTOR) && element.querySelector("ne-p")) return false;
      return true;
    });
    const elements = [...protectedNodes, ...textNodes].sort((left, right) => {
      if (left === right) return 0;
      return left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });

    const seenIds = new Set();
    let fallbackIndex = 0;
    return elements.map((element) => {
      const isProtectedNode = element.matches(PROTECTED_SELECTOR);
      const kind = isProtectedNode ? protectedKind(element) : textBlockKind(element, root);
      const textElement = isProtectedNode ? element : textElementFor(element);
      let id = lakeIdFor(element);
      if (!id || seenIds.has(id)) {
        fallbackIndex += 1;
        id = `readonly:${kind}:${fallbackIndex}`;
      }
      seenIds.add(id);
      const unsupported = isProtectedNode || hasUnsupportedInline(textElement);
      const hasStableId = !id.startsWith("readonly:");
      const editable = !unsupported && hasStableId;
      const nestedContainer = closestWithin(element, "li,blockquote,table,details,ne-oli-i,ne-uli-i,ne-alert,ne-quote", root);
      const topLevelParagraph = kind === "paragraph" && !nestedContainer;
      let text = textElement.textContent || "";
      if (isProtectedNode && !text.trim()) text = `[${kind}]`;
      if (isProtectedNode && text.length > 2_000) text = `${text.slice(0, 2_000)}…`;
      return {
        id,
        kind,
        text,
        editable,
        canInsertAfter: editable && topLevelParagraph,
        canDelete: editable && topLevelParagraph,
        element,
        textElement,
      };
    });
  }

  function publicBlock(record) {
    const { element: _element, textElement: _textElement, ...block } = record;
    return block;
  }

  function findScrollContainer(root) {
    for (let element = root; element; element = element.parentElement) {
      const style = getComputedStyle(element);
      if (/(auto|scroll)/u.test(style.overflowY) && element.scrollHeight > element.clientHeight + 20) return element;
    }
    return document.scrollingElement || document.documentElement;
  }

  function scrollTopOf(scroller) {
    return scroller === document.scrollingElement || scroller === document.documentElement
      ? window.scrollY
      : scroller.scrollTop;
  }

  function setScrollTop(scroller, top) {
    if (scroller === document.scrollingElement || scroller === document.documentElement) window.scrollTo({ top, behavior: "auto" });
    else scroller.scrollTo({ top, behavior: "auto" });
  }

  function scrollHeightOf(scroller) {
    return scroller === document.scrollingElement || scroller === document.documentElement
      ? document.documentElement.scrollHeight
      : scroller.scrollHeight;
  }

  function clientHeightOf(scroller) {
    return scroller === document.scrollingElement || scroller === document.documentElement
      ? window.innerHeight
      : scroller.clientHeight;
  }

  async function sha256(value) {
    const bytes = new TextEncoder().encode(String(value));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function projection(blocks, includeIds) {
    return blocks.map((block) => {
      const value = {
        kind: block.kind,
        text: block.text,
        editable: block.editable,
        canInsertAfter: block.canInsertAfter,
        canDelete: block.canDelete,
      };
      if (includeIds) value.id = block.id;
      return value;
    });
  }

  async function hashBlocks(blocks, includeIds) {
    return sha256(JSON.stringify(projection(blocks, includeIds)));
  }

  function selectedIds(root) {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      throw new Error("请先在语雀正文中选择至少一段文字");
    }
    const ids = new Set();
    for (let rangeIndex = 0; rangeIndex < selection.rangeCount; rangeIndex += 1) {
      const range = selection.getRangeAt(rangeIndex);
      for (const block of buildBlockRecords(root)) {
        try {
          if (range.intersectsNode(block.element)) ids.add(block.id);
        } catch {
          // 已被编辑器卸载的节点会在下一次采集时忽略。
        }
      }
    }
    if (!ids.size) throw new Error("选择范围没有包含可识别的语雀段落");
    return ids;
  }

  async function scanDocument(root) {
    const scroller = findScrollContainer(root);
    const originalTop = scrollTopOf(scroller);
    const collected = new Map();
    let sequence = 0;
    try {
      setScrollTop(scroller, 0);
      await sleep(80);
      let previousTop = -1;
      for (let pass = 0; pass < 240; pass += 1) {
        const currentTop = scrollTopOf(scroller);
        for (const block of buildBlockRecords(root)) {
          const rect = block.element.getBoundingClientRect();
          const position = currentTop + rect.top;
          const existing = collected.get(block.id);
          if (!existing || position < existing.position) {
            collected.set(block.id, { ...publicBlock(block), position, sequence: sequence++ });
          }
        }
        const maxTop = Math.max(0, scrollHeightOf(scroller) - clientHeightOf(scroller));
        if (currentTop >= maxTop - 2 || currentTop === previousTop) break;
        previousTop = currentTop;
        setScrollTop(scroller, Math.min(maxTop, currentTop + Math.max(240, clientHeightOf(scroller) * 0.8)));
        await sleep(65);
      }
    } finally {
      setScrollTop(scroller, originalTop);
      await sleep(30);
    }
    return Array.from(collected.values())
      .sort((left, right) => left.position - right.position || left.sequence - right.sequence)
      .map(({ position: _position, sequence: _sequence, ...block }) => block);
  }

  async function collect(scope) {
    const root = findEditorRoot();
    if (!root) throw new Error("没有检测到可编辑的语雀正文，请先进入编辑模式");
    const selection = scope === "selection" ? selectedIds(root) : null;
    const allBlocks = await scanDocument(root);
    const blocks = selection ? allBlocks.filter((block) => selection.has(block.id)) : allBlocks;
    if (!blocks.length) throw new Error("没有采集到段落");
    if (blocks.length > 500) throw new Error("段落超过 500 个，请改用选区模式");
    const charCount = blocks.reduce((sum, block) => sum + block.text.length, 0);
    if (charCount > 100_000) throw new Error("正文超过 100,000 字，请改用选区模式");
    return {
      title: document.title.replace(/\s*[·\-–—|]\s*语雀.*$/u, "").trim(),
      documentKey: documentKey(),
      scope,
      blocks,
      sourceHash: await hashBlocks(blocks, true),
      guardHash: await hashBlocks(allBlocks, false),
      stats: {
        blockCount: blocks.length,
        editableCount: blocks.filter((block) => block.editable).length,
        charCount,
      },
      diagnostic: {
        frameUrl: location.href,
        root: `${root.tagName.toLowerCase()}${root.id ? `#${root.id}` : ""}${root.className ? `.${String(root.className).trim().split(/\s+/u).slice(0, 4).join(".")}` : ""}`,
        lakeIdCount: root.querySelectorAll("[data-lake-id]").length,
        candidateBlockCount: root.querySelectorAll(BLOCK_SELECTOR).length,
        stableIdCount: Array.from(root.querySelectorAll(BLOCK_SELECTOR)).filter((element) => lakeIdFor(element)).length,
        contentEditableCount: root.querySelectorAll('[contenteditable="true"]').length + (root.matches('[contenteditable="true"]') ? 1 : 0),
      },
    };
  }

  async function locateBlock(root, id, keepPosition = true) {
    let found = buildBlockRecords(root).find((block) => block.id === id);
    if (found) return found;
    const scroller = findScrollContainer(root);
    const originalTop = scrollTopOf(scroller);
    let previousTop = -1;
    setScrollTop(scroller, 0);
    await sleep(50);
    for (let pass = 0; pass < 240; pass += 1) {
      found = buildBlockRecords(root).find((block) => block.id === id);
      if (found) {
        found.element.scrollIntoView({ block: "center", behavior: "auto" });
        await sleep(30);
        return found;
      }
      const currentTop = scrollTopOf(scroller);
      const maxTop = Math.max(0, scrollHeightOf(scroller) - clientHeightOf(scroller));
      if (currentTop >= maxTop - 2 || currentTop === previousTop) break;
      previousTop = currentTop;
      setScrollTop(scroller, Math.min(maxTop, currentTop + Math.max(240, clientHeightOf(scroller) * 0.8)));
      await sleep(50);
    }
    if (!keepPosition) setScrollTop(scroller, originalTop);
    return null;
  }

  function assertDocument(expectedDocumentKey) {
    if (expectedDocumentKey && expectedDocumentKey !== documentKey()) {
      throw new Error("语雀页面已经切换，已停止写入");
    }
  }

  function textPosition(element, offset) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    let consumed = 0;
    let last = null;
    while (node) {
      const next = consumed + node.data.length;
      if (offset <= next) return { node, offset: Math.max(0, offset - consumed) };
      consumed = next;
      last = node;
      node = walker.nextNode();
    }
    if (last && offset === consumed) return { node: last, offset: last.data.length };
    if (offset === 0) return { node: element, offset: 0 };
    throw new Error("无法把文字位置映射到编辑器节点");
  }

  async function selectTextRange(message) {
    assertDocument(message.documentKey);
    const root = findEditorRoot();
    if (!root) throw new Error("语雀编辑器已离开编辑模式");
    const block = await locateBlock(root, message.blockId);
    if (!block || !block.editable) throw new Error(`找不到可编辑段落：${message.blockId}`);
    if (block.text !== message.expectedText) throw new Error(`段落 ${message.blockId} 已发生变化`);
    if (message.start < 0 || message.end < message.start || message.end > block.text.length) {
      throw new Error("替换范围越界");
    }
    const start = textPosition(block.textElement, message.start);
    const end = textPosition(block.textElement, message.end);
    (block.textElement.closest('[contenteditable="true"]') || root).focus({ preventScroll: true });
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }

  async function placeCaretAtEnd(message) {
    assertDocument(message.documentKey);
    const root = findEditorRoot();
    if (!root) throw new Error("语雀编辑器已离开编辑模式");
    const block = await locateBlock(root, message.blockId);
    if (!block?.canInsertAfter) throw new Error(`不能在段落 ${message.blockId} 后创建段落`);
    if (block.text !== message.expectedText) throw new Error(`段落 ${message.blockId} 已发生变化`);
    const end = textPosition(block.textElement, block.text.length);
    (block.textElement.closest('[contenteditable="true"]') || root).focus({ preventScroll: true });
    const range = document.createRange();
    range.setStart(end.node, end.offset);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }

  async function selectWholeBlock(message) {
    assertDocument(message.documentKey);
    const root = findEditorRoot();
    if (!root) throw new Error("语雀编辑器已离开编辑模式");
    const block = await locateBlock(root, message.blockId);
    if (!block?.canDelete) throw new Error(`不能删除段落 ${message.blockId}`);
    if (block.text !== message.expectedText) throw new Error(`段落 ${message.blockId} 已发生变化`);
    (block.element.closest('[contenteditable="true"]') || root).focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNode(block.element);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }

  async function blockState(message) {
    assertDocument(message.documentKey);
    const root = findEditorRoot();
    if (!root) throw new Error("语雀编辑器已离开编辑模式");
    const records = buildBlockRecords(root);
    const index = records.findIndex((block) => block.id === message.blockId);
    if (index < 0) return { exists: false };
    return {
      exists: true,
      block: publicBlock(records[index]),
      previous: index > 0 ? publicBlock(records[index - 1]) : null,
      next: index + 1 < records.length ? publicBlock(records[index + 1]) : null,
    };
  }

  async function waitForText(message) {
    assertDocument(message.documentKey);
    const deadline = Date.now() + (message.timeoutMs || 2_500);
    while (Date.now() < deadline) {
      const root = findEditorRoot();
      const block = root ? await locateBlock(root, message.blockId) : null;
      if (block?.text === message.expectedText) return publicBlock(block);
      await sleep(60);
    }
    throw new Error(`段落 ${message.blockId} 写入后校验失败`);
  }

  async function waitForInsertedParagraph(message) {
    assertDocument(message.documentKey);
    const deadline = Date.now() + (message.timeoutMs || 3_000);
    while (Date.now() < deadline) {
      const root = findEditorRoot();
      if (root) {
        const records = buildBlockRecords(root);
        const anchorIndex = records.findIndex((block) => block.id === message.anchorId);
        const candidate = anchorIndex >= 0 ? records[anchorIndex + 1] : null;
        if (candidate?.kind === "paragraph" && candidate.text === message.expectedText) {
          return publicBlock(candidate);
        }
      }
      await sleep(70);
    }
    throw new Error("新段落写入后校验失败");
  }

  async function currentGuard(message) {
    assertDocument(message.documentKey);
    const root = findEditorRoot();
    if (!root) throw new Error("语雀编辑器已离开编辑模式");
    const blocks = await scanDocument(root);
    return { guardHash: await hashBlocks(blocks, false), blocks };
  }

  async function waitForSaved(message) {
    assertDocument(message.documentKey);
    const deadline = Date.now() + (message.timeoutMs || 15_000);
    while (Date.now() < deadline) {
      const text = document.body?.innerText || "";
      if (/(已保存|保存成功)/u.test(text)) return { saved: true };
      if (/(保存失败|同步失败|网络异常)/u.test(text)) return { saved: false, error: "语雀显示保存失败" };
      await sleep(300);
    }
    return { saved: null, warning: "未识别到语雀的“已保存”提示，请稍后刷新确认" };
  }

  const handlers = {
    PING_EDITOR: async () => {
      const root = findEditorRoot();
      return {
        ready: Boolean(root),
        documentKey: documentKey(),
        title: document.title,
        diagnostic: root ? {
          frameUrl: location.href,
          root: `${root.tagName.toLowerCase()}${root.id ? `#${root.id}` : ""}${root.className ? `.${String(root.className).trim().split(/\s+/u).slice(0, 4).join(".")}` : ""}`,
          lakeIdCount: root.querySelectorAll("[data-lake-id]").length,
          candidateBlockCount: root.querySelectorAll(BLOCK_SELECTOR).length,
          stableIdCount: Array.from(root.querySelectorAll(BLOCK_SELECTOR)).filter((element) => lakeIdFor(element)).length,
        } : { frameUrl: location.href },
      };
    },
    COLLECT_DOCUMENT: (message) => collect(message.scope),
    SELECT_TEXT_RANGE: selectTextRange,
    PLACE_CARET_END: placeCaretAtEnd,
    SELECT_WHOLE_BLOCK: selectWholeBlock,
    GET_BLOCK_STATE: blockState,
    WAIT_FOR_TEXT: waitForText,
    WAIT_FOR_INSERT: waitForInsertedParagraph,
    GET_GUARD: currentGuard,
    WAIT_FOR_SAVE: waitForSaved,
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
