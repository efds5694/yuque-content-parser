export const SCHEMA_VERSION = 1;
export const MAX_LAKE_BYTES = 20 * 1024 * 1024;

const BLOCK_TAGS = new Set([
  "P", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "BLOCKQUOTE",
  "TABLE", "DETAILS", "PRE", "HR", "ARTICLE", "SECTION", "FIGURE",
  "NE-P", "NE-H1", "NE-H2", "NE-H3", "NE-H4", "NE-H5", "NE-H6", "NE-TLI",
  "NE-TABLE", "NE-CODEBLOCK", "NE-COLLAPSE", "NE-ALERT", "NE-ALERT-HOLE",
  "NE-HOLE", "NE-CARD",
]);
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "META", "TITLE", "LINK"]);
const FILLER_SELECTOR = ".ne-b-filler,.ne-i-filler,[ne-filler]";

function diagnostic(context, code, message, severity = "warning", detail = {}) {
  context.diagnostics.push({ severity, code, message, ...detail });
}

function textValue(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function cleanText(value) {
  return textValue(value).replace(/[\u200B\uFEFF]/gu, "");
}

export function decodeCardPayload(rawValue) {
  const raw = textValue(rawValue);
  if (!raw) return { decoded: "", data: null, error: "missing" };
  const encoded = raw.startsWith("data:") ? raw.slice(5) : raw;
  let decoded = encoded;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    return { decoded: encoded, data: null, error: "malformed-percent-encoding" };
  }
  try {
    return { decoded, data: JSON.parse(decoded), error: "" };
  } catch {
    return { decoded, data: null, error: "invalid-json" };
  }
}

export function sanitizeUrl(value, options = {}) {
  const raw = textValue(value).trim();
  if (!raw) return "";
  if (raw.startsWith("#")) return raw;
  if (/^(?:https?:|mailto:|tel:)/iu.test(raw)) return raw;
  if (/^(?:\/\/|\/|\.\/|\.\.\/)/u.test(raw)) return raw;
  if (!/^[a-z][a-z\d+.-]*:/iu.test(raw)) return raw;
  if (options.allowImageData && /^data:image\/(?:png|jpe?g|gif|webp);base64,/iu.test(raw)) return raw;
  return "";
}

function safeUrl(value, context, element, options = {}) {
  const raw = textValue(value).trim();
  if (raw.startsWith("#")) {
    const original = raw.slice(1);
    const rewritten = context.anchorMap.get(original);
    if (rewritten) return `#${rewritten}`;
    diagnostic(context, "UNRESOLVED_ANCHOR", `页内链接目标不存在：${raw}`, "warning", {
      sourceId: element?.id || undefined,
    });
    return raw;
  }
  const safe = sanitizeUrl(raw, options);
  if (!safe && raw) {
    diagnostic(context, "UNSAFE_URL", `已移除不安全链接：${raw.slice(0, 160)}`, "warning", {
      sourceId: element?.id || undefined,
    });
  }
  return safe;
}

function firstString(object, keys) {
  if (!object || typeof object !== "object") return "";
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function collectStrings(value, keys, output = []) {
  if (!value || typeof value !== "object" || output.length >= 12) return output;
  for (const [key, nested] of Object.entries(value)) {
    if (keys.has(key) && typeof nested === "string" && nested.trim()) output.push(nested.trim());
    else if (nested && typeof nested === "object") collectStrings(nested, keys, output);
    if (output.length >= 12) break;
  }
  return output;
}

function slugify(value, fallback) {
  const slug = cleanText(value)
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 72);
  return slug || fallback;
}

function closestBlock(element, root) {
  let current = element;
  while (current && current !== root) {
    if (BLOCK_TAGS.has(current.tagName) || current.tagName === "CARD") return current;
    current = current.parentElement;
  }
  return element;
}

function prepareAnchors(root, context) {
  const used = new Set();
  const selectors = Array.from(root.querySelectorAll?.('a[href^="#"],ne-link[href^="#"]') || []);
  for (const link of selectors) {
    const original = (link.getAttribute("href") || "").slice(1);
    if (!original || context.anchorMap.has(original)) continue;
    const escaped = globalThis.CSS?.escape ? CSS.escape(original) : original.replace(/["\\]/gu, "\\$&");
    const target = root.querySelector?.(`#${escaped},[data-lake-id="${escaped}"]`);
    if (!target) continue;
    const block = closestBlock(target, root);
    const base = slugify(block.textContent || "", `section-${used.size + 1}`);
    let slug = base;
    let suffix = 2;
    while (used.has(slug)) slug = `${base}-${suffix++}`;
    used.add(slug);
    context.anchorMap.set(original, slug);
    context.anchorByElement.set(block, slug);
  }
}

function mergeTextNodes(nodes) {
  const output = [];
  for (const node of nodes.flat().filter(Boolean)) {
    const last = output.at(-1);
    if (node.type === "text" && last?.type === "text") last.text += node.text;
    else output.push(node);
  }
  return output.filter((node) => node.type !== "text" || node.text !== "");
}

function wrapMark(type, children, attributes = {}) {
  const merged = mergeTextNodes(children);
  return merged.length ? [{ type, children: merged, ...attributes }] : [];
}

function elementChildren(element, context) {
  return mergeTextNodes(Array.from(element.childNodes || [], (child) => parseInlineNode(child, context)));
}

function parseImage(element, context, data = null) {
  const rawUrl = firstString(data, ["src", "url", "origin", "original", "image", "downloadUrl"])
    || element.getAttribute?.("data-origin-src")
    || element.getAttribute?.("data-src")
    || element.getAttribute?.("src")
    || "";
  const url = safeUrl(rawUrl, context, element, { allowImageData: false });
  const alt = firstString(data, ["alt", "name", "filename", "title"])
    || element.getAttribute?.("alt")
    || element.getAttribute?.("title")
    || "语雀图片";
  if (!url) {
    diagnostic(context, "MISSING_IMAGE_URL", "图片缺少可安全保留的原始地址", "warning", {
      sourceId: element.id || undefined,
    });
  }
  return {
    type: "image",
    url,
    alt: cleanText(alt),
    title: firstString(data, ["title"]) || element.getAttribute?.("title") || "",
    width: Number(data?.width || data?.originWidth || element.getAttribute?.("width")) || undefined,
    height: Number(data?.height || data?.originHeight || element.getAttribute?.("height")) || undefined,
  };
}

function renderedCardSummary(element) {
  return cleanText(element.textContent || "").replace(/\s+/gu, " ").trim().slice(0, 500);
}

function unknownCard(name, payload, element, context, renderedOnly = false) {
  const data = payload?.data;
  const texts = collectStrings(data, new Set(["title", "name", "label", "text", "desc", "description", "filename"]));
  const rawLinks = collectStrings(data, new Set(["url", "src", "href", "downloadUrl", "image"]));
  const links = rawLinks.map((url) => safeUrl(url, context, element)).filter(Boolean);
  const summary = texts.join(" · ").slice(0, 500) || renderedCardSummary(element) || "未提供可读摘要";
  diagnostic(context, renderedOnly ? "RENDERED_CARD_ONLY" : "UNKNOWN_CARD", renderedOnly
    ? `网页只提供了 ${name} 卡片的渲染结果`
    : `尚未识别语雀卡片：${name}`, "warning", { cardName: name, sourceId: element.id || undefined });
  return {
    type: "unknownCard",
    name,
    summary,
    links,
    raw: data ?? payload?.decoded ?? null,
    renderedOnly,
  };
}

function parseCard(element, context, inline = false) {
  const name = textValue(
    element.getAttribute("name")
      || element.getAttribute("data-card-name")
      || element.getAttribute("data-card")
      || "unknown",
  ).toLocaleLowerCase("en-US");
  const rawValue = element.getAttribute("value") || element.getAttribute("data-card-value") || "";
  const renderedOnly = element.tagName === "NE-CARD" && !rawValue;
  const payload = decodeCardPayload(rawValue);
  if (rawValue && payload.error) {
    diagnostic(context, "MALFORMED_CARD_VALUE", `卡片 ${name} 的 value 无法完整解析`, "warning", {
      cardName: name,
      sourceId: element.id || undefined,
    });
  }
  const data = payload.data || {};

  if (name === "hr" || name === "divider") return { type: "thematicBreak" };
  if (["image", "img"].includes(name)) return parseImage(element.querySelector("img") || element, context, data);
  if (["label", "tag", "status"].includes(name)) {
    return { type: "label", text: cleanText(firstString(data, ["label", "text", "name"]) || renderedCardSummary(element) || name), color: data.color || data.colorIndex };
  }
  if (["codeblock", "code"].includes(name)) {
    const text = firstString(data, ["code", "text", "value"]) || cleanText(element.textContent || "");
    if (renderedOnly) diagnostic(context, "RENDERED_CARD_ONLY", "代码块只保留了页面渲染文本", "warning", { cardName: name });
    return { type: "codeBlock", language: firstString(data, ["language", "lang", "mode"]), text, renderedOnly };
  }
  if (["diagram", "textdiagram", "mermaid", "mindmap", "flowchart"].includes(name)) {
    const source = firstString(data, ["code", "source", "text"]);
    if (!source) return unknownCard(name, payload, element, context, true);
    return { type: "diagram", kind: firstString(data, ["type", "mode"]) || name, source };
  }
  if (["formula", "math", "latex"].includes(name)) {
    return { type: "formula", display: !inline, text: firstString(data, ["code", "latex", "text", "value"]) || renderedCardSummary(element) };
  }
  if (["yuque", "doc", "embed", "bookmark"].includes(name)) {
    const detail = data.detail && typeof data.detail === "object" ? data.detail : {};
    const url = safeUrl(firstString(data, ["src", "url", "href"]) || firstString(detail, ["url"]), context, element);
    return {
      type: "embed",
      kind: name,
      title: cleanText(firstString(detail, ["title", "name"]) || firstString(data, ["title", "name"]) || "嵌入内容"),
      url,
      description: cleanText(firstString(detail, ["desc", "description"]) || firstString(data, ["desc", "description"])),
    };
  }
  if (["attachment", "file"].includes(name)) {
    return {
      type: "attachment",
      name: cleanText(firstString(data, ["filename", "name", "title"]) || "附件"),
      url: safeUrl(firstString(data, ["url", "src", "downloadUrl", "href"]), context, element),
      size: Number(data.size) || undefined,
    };
  }
  if (["video", "audio"].includes(name)) {
    return {
      type: "media",
      kind: name,
      title: cleanText(firstString(data, ["title", "name"]) || name),
      url: safeUrl(firstString(data, ["url", "src"]), context, element),
      poster: safeUrl(firstString(data, ["poster", "image"]), context, element),
    };
  }
  return unknownCard(name, payload, element, context, renderedOnly);
}

function parseInlineNode(node, context) {
  if (node.nodeType === 3) return [{ type: "text", text: cleanText(node.nodeValue || "") }];
  if (node.nodeType !== 1) return [];
  const element = node;
  const tag = element.tagName;
  if (SKIP_TAGS.has(tag) || element.matches?.(FILLER_SELECTOR)) return [];
  if (tag === "BR") return [{ type: "lineBreak" }];
  if (tag === "IMG") return [parseImage(element, context)];
  if (tag === "CARD" || tag === "NE-CARD") {
    const card = parseCard(element, context, true);
    return [card];
  }

  let children = elementChildren(element, context);
  if (tag === "A" || tag === "NE-LINK") {
    const url = safeUrl(element.getAttribute("href") || element.getAttribute("data-href") || element.getAttribute("url"), context, element);
    return url ? wrapMark("link", children, { url }) : children;
  }
  if (tag === "CODE") return [{ type: "inlineCode", text: cleanText(element.textContent || "") }];
  if (["STRONG", "B"].includes(tag) || element.getAttribute("ne-bold") === "true") children = wrapMark("strong", children);
  if (["EM", "I"].includes(tag) || element.getAttribute("ne-italic") === "true") children = wrapMark("emphasis", children);
  if (tag === "U" || element.getAttribute("ne-underline") === "true") children = wrapMark("underline", children);
  if (["S", "DEL"].includes(tag) || element.getAttribute("ne-strikethrough") === "true") children = wrapMark("strike", children);
  if (tag === "MARK" || element.getAttribute("ne-highlight") === "true") children = wrapMark("highlight", children);

  const style = element.getAttribute("style") || "";
  const color = style.match(/(?:^|;)\s*color\s*:\s*([^;]+)/iu)?.[1]?.trim();
  const backgroundColor = style.match(/(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/iu)?.[1]?.trim();
  if ((color || backgroundColor) && children.length) {
    children = wrapMark("styled", children, { style: { ...(color ? { color } : {}), ...(backgroundColor ? { backgroundColor } : {}) } });
  }
  return children;
}

function blockAnchor(element, context) {
  return context.anchorByElement.get(element) || undefined;
}

function parseParagraph(element, context) {
  const children = elementChildren(element, context);
  return children.length ? { type: "paragraph", children, anchor: blockAnchor(element, context) } : null;
}

function parseHeading(element, context) {
  const match = element.tagName.match(/(?:NE-)?H([1-6])/u);
  const content = element.querySelector?.(":scope > ne-heading-content") || element;
  const children = elementChildren(content, context);
  return children.length ? { type: "heading", level: Number(match?.[1] || 2), children, anchor: blockAnchor(element, context) } : null;
}

function parseList(element, context) {
  const ordered = element.tagName === "OL";
  const directItems = Array.from(element.children || []).filter((child) => child.tagName === "LI");
  const items = directItems.map((item) => parseListItem(item, context)).filter(Boolean);
  return items.length ? { type: "list", ordered, start: ordered ? Number(element.getAttribute("start")) || 1 : undefined, items } : null;
}

function parseListItem(element, context) {
  const checkedRaw = element.getAttribute("checked") ?? element.getAttribute("data-checked") ?? element.getAttribute("ne-checked");
  const checked = checkedRaw == null ? null : !["false", "0", "unchecked"].includes(String(checkedRaw).toLocaleLowerCase("en-US"));
  const children = parseBlocks(element, context);
  if (!children.length) {
    const inlines = elementChildren(element, context);
    if (inlines.length) children.push({ type: "paragraph", children: inlines });
  }
  return children.length ? { type: "listItem", checked, children } : null;
}

function parseCustomListItem(element, context) {
  const content = element.querySelector(":scope > ne-uli-c,:scope > ne-oli-c") || element;
  const children = elementChildren(content, context);
  const ordered = Boolean(element.querySelector(":scope > ne-oli-i")) || element.getAttribute("data-list-type") === "ordered";
  const checkedRaw = element.getAttribute("ne-checked") ?? element.getAttribute("data-checked");
  return children.length ? {
    type: "list",
    ordered,
    start: ordered ? Number(element.getAttribute("start")) || 1 : undefined,
    items: [{ type: "listItem", checked: checkedRaw == null ? null : checkedRaw !== "false", children: [{ type: "paragraph", children }] }],
  } : null;
}

function parseTable(element, context) {
  const table = element.tagName === "TABLE" ? element : element.querySelector("table") || element;
  const rowElements = Array.from(table.querySelectorAll(":scope > thead > tr,:scope > tbody > tr,:scope > tfoot > tr,:scope > tr"));
  const rows = rowElements.map((row) => ({
    type: "tableRow",
    cells: Array.from(row.children).filter((cell) => ["TD", "TH"].includes(cell.tagName)).map((cell) => {
      let children = parseBlocks(cell, context);
      if (!children.length) {
        const inlines = elementChildren(cell, context);
        if (inlines.length) children = [{ type: "paragraph", children: inlines }];
      }
      return {
        type: "tableCell",
        header: cell.tagName === "TH",
        rowspan: Math.max(1, Number(cell.getAttribute("rowspan")) || 1),
        colspan: Math.max(1, Number(cell.getAttribute("colspan")) || 1),
        children,
      };
    }),
  })).filter((row) => row.cells.length);
  return rows.length ? { type: "table", rows, anchor: blockAnchor(element, context) } : null;
}

function parseDetails(element, context) {
  const summaryElement = Array.from(element.children || []).find((child) => ["SUMMARY", "NE-SUMMARY"].includes(child.tagName));
  const summary = summaryElement ? elementChildren(summaryElement, context) : [{ type: "text", text: "折叠内容" }];
  const wrapper = element.cloneNode(true);
  const clonedSummary = Array.from(wrapper.children || []).find((child) => ["SUMMARY", "NE-SUMMARY"].includes(child.tagName));
  clonedSummary?.remove();
  return { type: "details", summary, children: parseBlocks(wrapper, context), anchor: blockAnchor(element, context) };
}

function parsePre(element) {
  const code = element.querySelector("code");
  const language = code?.className?.match(/(?:language|lang)-([^\s]+)/u)?.[1] || element.getAttribute("data-language") || "";
  return { type: "codeBlock", language, text: cleanText(code?.textContent ?? element.textContent ?? "") };
}

function parseBlockElement(element, context) {
  const tag = element.tagName;
  if (SKIP_TAGS.has(tag)) return [];
  if (tag === "P" || tag === "NE-P") return [parseParagraph(element, context)].filter(Boolean);
  if (/^(?:NE-)?H[1-6]$/u.test(tag)) return [parseHeading(element, context)].filter(Boolean);
  if (tag === "UL" || tag === "OL") return [parseList(element, context)].filter(Boolean);
  if (tag === "LI") return [{ type: "list", ordered: false, items: [parseListItem(element, context)] }].filter((node) => node.items[0]);
  if (tag === "NE-TLI") return [parseCustomListItem(element, context)].filter(Boolean);
  if (tag === "BLOCKQUOTE") return [{ type: "quote", children: parseBlocks(element, context), anchor: blockAnchor(element, context) }];
  if (tag === "NE-ALERT") return [{ type: "alert", kind: element.getAttribute("ne-alert-type") || "info", children: parseBlocks(element, context) }];
  if (tag === "TABLE" || tag === "NE-TABLE") return [parseTable(element, context)].filter(Boolean);
  if (tag === "DETAILS" || tag === "NE-COLLAPSE") return [parseDetails(element, context)];
  if (tag === "PRE") return [parsePre(element)];
  if (tag === "NE-CODEBLOCK") return [{ type: "codeBlock", language: element.getAttribute("data-language") || "", text: cleanText(element.textContent || ""), renderedOnly: true }];
  if (tag === "HR") return [{ type: "thematicBreak" }];
  if (tag === "CARD" || tag === "NE-CARD") return [parseCard(element, context, false)];
  if (["NE-HOLE", "NE-ALERT-HOLE"].includes(tag)) return parseBlocks(element, context);
  if (tag === "IMG") return [{ type: "paragraph", children: [parseImage(element, context)] }];
  if (["ARTICLE", "SECTION", "DIV", "FIGURE"].includes(tag)) {
    const nested = parseBlocks(element, context);
    if (nested.length) return nested;
  }
  const inlines = elementChildren(element, context);
  return inlines.length ? [{ type: "paragraph", children: inlines }] : [];
}

function mergeAdjacentLists(blocks) {
  const output = [];
  for (const block of blocks.filter(Boolean)) {
    const last = output.at(-1);
    if (block.type === "list" && last?.type === "list" && block.ordered === last.ordered
      && (block.start == null || last.start == null || block.start === last.start + last.items.length)) {
      last.items.push(...block.items);
    } else output.push(block);
  }
  return output;
}

function parseBlocks(container, context) {
  const blocks = [];
  let pendingInline = [];
  const flushInline = () => {
    pendingInline = mergeTextNodes(pendingInline);
    const meaningful = pendingInline.some((node) => node.type !== "text" || node.text.trim());
    if (meaningful) blocks.push({ type: "paragraph", children: pendingInline });
    pendingInline = [];
  };
  for (const child of Array.from(container.childNodes || [])) {
    if (child.nodeType === 3) {
      const text = cleanText(child.nodeValue || "");
      if (text.trim()) pendingInline.push({ type: "text", text });
      continue;
    }
    if (child.nodeType !== 1 || SKIP_TAGS.has(child.tagName) || child.matches?.(FILLER_SELECTOR)) continue;
    const isBlock = BLOCK_TAGS.has(child.tagName) || child.tagName === "CARD" || child.tagName === "DIV";
    if (isBlock) {
      flushInline();
      blocks.push(...parseBlockElement(child, context));
    } else {
      pendingInline.push(...parseInlineNode(child, context));
    }
  }
  flushInline();
  return mergeAdjacentLists(blocks);
}

function countStats(blocks, diagnostics) {
  const stats = { nodes: 0, characters: 0, images: 0, cards: 0, warnings: diagnostics.filter((item) => item.severity === "warning").length };
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (typeof value.type === "string") {
      stats.nodes += 1;
      if (value.type === "text" || value.type === "inlineCode") stats.characters += textValue(value.text).length;
      if (value.type === "image") stats.images += 1;
      if (["unknownCard", "embed", "attachment", "media", "diagram"].includes(value.type)) stats.cards += 1;
    }
    for (const [key, nested] of Object.entries(value)) {
      if (key === "raw") continue;
      if (Array.isArray(nested)) nested.forEach(visit);
      else if (nested && typeof nested === "object") visit(nested);
    }
  };
  blocks.forEach(visit);
  return stats;
}

function titleFromFilename(filename) {
  return textValue(filename).replace(/\.(?:lake|html?)$/iu, "").trim();
}

function createContext() {
  return { diagnostics: [], anchorMap: new Map(), anchorByElement: new WeakMap() };
}

function finalize(root, metadata, sourceKind, fidelity) {
  const context = createContext();
  prepareAnchors(root, context);
  const blocks = parseBlocks(root, context);
  if (!blocks.length) diagnostic(context, "EMPTY_DOCUMENT", "没有识别到可导出的正文", "error");
  if (sourceKind === "page") {
    diagnostic(context, "PAGE_RENDERED_SOURCE", "网页模式只解析当前可见的渲染信息；高级卡片可能降级", "warning");
  }
  const title = cleanText(metadata.title || titleFromFilename(metadata.fileName) || "未命名语雀文档").trim();
  const source = {
    kind: sourceKind,
    scope: metadata.scope === "selection" ? "selection" : "document",
    fidelity,
    ...(metadata.url ? { url: metadata.url } : {}),
    ...(metadata.fileName ? { fileName: metadata.fileName } : {}),
  };
  return {
    schemaVersion: SCHEMA_VERSION,
    document: { title, source, blocks },
    diagnostics: context.diagnostics,
    stats: countStats(blocks, context.diagnostics),
  };
}

export function parseLake(source, metadata = {}) {
  if (typeof source !== "string") throw new Error(".lake 内容必须是文本");
  const bytes = new TextEncoder().encode(source).byteLength;
  if (bytes > MAX_LAKE_BYTES) throw new Error(`.lake 文件不能超过 ${MAX_LAKE_BYTES / 1024 / 1024} MiB`);
  if (typeof DOMParser !== "function") throw new Error("当前环境不支持 DOMParser");
  const documentNode = new DOMParser().parseFromString(source, "text/html");
  const result = finalize(documentNode.body, {
    ...metadata,
    title: metadata.title || documentNode.querySelector("title")?.textContent || "",
    scope: "document",
  }, "lake", "source");
  if (!/^\s*<!doctype\s+lake\b/iu.test(source)) {
    result.diagnostics.unshift({ severity: "warning", code: "MISSING_LAKE_DOCTYPE", message: "文件缺少 <!doctype lake> 标记，已按 Lake HTML 尝试解析" });
    result.stats.warnings += 1;
  }
  return result;
}

export function parsePageHtml(source, metadata = {}) {
  if (typeof source !== "string") throw new Error("页面片段必须是文本");
  if (typeof DOMParser !== "function") throw new Error("当前环境不支持 DOMParser");
  const documentNode = new DOMParser().parseFromString(`<body>${source}</body>`, "text/html");
  return finalize(documentNode.body, metadata, "page", "rendered");
}
