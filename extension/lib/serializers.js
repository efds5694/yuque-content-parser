import { SCHEMA_VERSION, sanitizeUrl } from "./parser.js";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

function escapeMarkdown(value) {
  return String(value ?? "").replace(/([\\`*_[\]<>])/gu, "\\$1");
}

function safeStyle(style = {}) {
  const values = [];
  if (style.color && /^#[\da-f]{3,8}$|^(?:rgb|hsl)a?\([\d\s.,%]+\)$/iu.test(style.color)) values.push(`color:${style.color}`);
  if (style.backgroundColor && /^#[\da-f]{3,8}$|^(?:rgb|hsl)a?\([\d\s.,%]+\)$/iu.test(style.backgroundColor)) values.push(`background-color:${style.backgroundColor}`);
  return values.join(";");
}

function outputUrl(value) {
  return sanitizeUrl(value);
}

function inlineText(nodes = []) {
  return nodes.map((node) => {
    if (["text", "inlineCode"].includes(node.type)) return node.text || "";
    if (["image", "attachment", "embed", "media"].includes(node.type)) return node.alt || node.name || node.title || "";
    if (node.type === "label") return node.text || "";
    if (node.type === "formula") return node.text || "";
    return inlineText(node.children || []);
  }).join("");
}

function markdownInline(nodes = []) {
  return nodes.map((node) => {
    switch (node.type) {
      case "text": return escapeMarkdown(node.text);
      case "strong": return `**${markdownInline(node.children)}**`;
      case "emphasis": return `*${markdownInline(node.children)}*`;
      case "underline": return `<u>${markdownInline(node.children)}</u>`;
      case "strike": return `~~${markdownInline(node.children)}~~`;
      case "highlight": return `<mark>${markdownInline(node.children)}</mark>`;
      case "styled": {
        const style = safeStyle(node.style);
        return style ? `<span style="${style}">${markdownInline(node.children)}</span>` : markdownInline(node.children);
      }
      case "inlineCode": {
        const text = String(node.text || "");
        const longest = Math.max(0, ...Array.from(text.matchAll(/`+/gu), (match) => match[0].length));
        const fence = "`".repeat(longest + 1);
        return `${fence}${text}${fence}`;
      }
      case "link": {
        const url = outputUrl(node.url);
        return url ? `[${markdownInline(node.children) || escapeMarkdown(url)}](${url})` : markdownInline(node.children);
      }
      case "image": {
        const url = outputUrl(node.url);
        return url ? `![${escapeMarkdown(node.alt || "语雀图片")}](${url}${node.title ? ` \"${node.title.replace(/"/gu, "\\\"")}\"` : ""})` : `［图片：${escapeMarkdown(node.alt || "无地址")}］`;
      }
      case "label": return `【${escapeMarkdown(node.text || "标签")}】`;
      case "formula": return `$${String(node.text || "").replace(/\$/gu, "\\$")}$`;
      case "lineBreak": return "  \n";
      case "unknownCard": return `［语雀卡片：${escapeMarkdown(node.name || "unknown")}；${escapeMarkdown(node.summary || "无摘要")}］`;
      default: return markdownInline(node.children || []);
    }
  }).join("");
}

function codeFence(text) {
  const longest = Math.max(0, ...Array.from(String(text).matchAll(/`+/gu), (match) => match[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

function indentLines(value, prefix) {
  return String(value).split("\n").map((line) => `${prefix}${line}`).join("\n");
}

function tableIsSimple(table) {
  if (!table.rows.length || !table.rows[0].cells.length) return false;
  const width = table.rows[0].cells.length;
  return table.rows.every((row) => row.cells.length === width && row.cells.every((cell) => (
    cell.rowspan === 1 && cell.colspan === 1
    && cell.children.length <= 1
    && (!cell.children[0] || cell.children[0].type === "paragraph")
    && !inlineText(cell.children[0]?.children || []).includes("\n")
  )));
}

function htmlInline(nodes = []) {
  return nodes.map((node) => {
    switch (node.type) {
      case "text": return escapeHtml(node.text);
      case "strong": return `<strong>${htmlInline(node.children)}</strong>`;
      case "emphasis": return `<em>${htmlInline(node.children)}</em>`;
      case "underline": return `<u>${htmlInline(node.children)}</u>`;
      case "strike": return `<del>${htmlInline(node.children)}</del>`;
      case "highlight": return `<mark>${htmlInline(node.children)}</mark>`;
      case "styled": {
        const style = safeStyle(node.style);
        return style ? `<span style="${escapeHtml(style)}">${htmlInline(node.children)}</span>` : htmlInline(node.children);
      }
      case "inlineCode": return `<code>${escapeHtml(node.text)}</code>`;
      case "link": {
        const url = outputUrl(node.url);
        return url ? `<a href="${escapeHtml(url)}">${htmlInline(node.children) || escapeHtml(url)}</a>` : htmlInline(node.children);
      }
      case "image": {
        const url = outputUrl(node.url);
        return url
          ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(node.alt || "语雀图片")}"${node.title ? ` title="${escapeHtml(node.title)}"` : ""}${node.width ? ` width="${Number(node.width)}"` : ""}${node.height ? ` height="${Number(node.height)}"` : ""}>`
          : `<span class="missing-image">［图片：${escapeHtml(node.alt || "无地址")}］</span>`;
      }
      case "label": return `<span class="yuque-label">${escapeHtml(node.text || "标签")}</span>`;
      case "formula": return `<code class="math math-inline">${escapeHtml(node.text)}</code>`;
      case "lineBreak": return "<br>";
      case "unknownCard": return `<span class="yuque-card-placeholder" data-card-name="${escapeHtml(node.name || "unknown")}">［语雀卡片：${escapeHtml(node.name || "unknown")}；${escapeHtml(node.summary || "无摘要")}］</span>`;
      default: return htmlInline(node.children || []);
    }
  }).join("");
}

function htmlBlock(node) {
  const anchor = node.anchor ? ` id="${escapeHtml(node.anchor)}"` : "";
  switch (node.type) {
    case "paragraph": return `<p${anchor}>${htmlInline(node.children)}</p>`;
    case "heading": return `<h${node.level}${anchor}>${htmlInline(node.children)}</h${node.level}>`;
    case "list": return `<${node.ordered ? "ol" : "ul"}${node.ordered && node.start !== 1 ? ` start="${Number(node.start)}"` : ""}>${node.items.map((item) => {
      const check = item.checked == null ? "" : `<input type="checkbox" disabled${item.checked ? " checked" : ""}> `;
      return `<li>${check}${item.children.map(htmlBlock).join("")}</li>`;
    }).join("")}</${node.ordered ? "ol" : "ul"}>`;
    case "quote": return `<blockquote${anchor}>${node.children.map(htmlBlock).join("")}</blockquote>`;
    case "alert": return `<aside class="yuque-alert yuque-alert-${escapeHtml(node.kind || "info")}">${node.children.map(htmlBlock).join("")}</aside>`;
    case "table": return `<table${anchor}><tbody>${node.rows.map((row) => `<tr>${row.cells.map((cell) => `<${cell.header ? "th" : "td"}${cell.rowspan > 1 ? ` rowspan="${cell.rowspan}"` : ""}${cell.colspan > 1 ? ` colspan="${cell.colspan}"` : ""}>${cell.children.map(htmlBlock).join("")}</${cell.header ? "th" : "td"}>`).join("")}</tr>`).join("")}</tbody></table>`;
    case "details": return `<details${anchor} open><summary>${htmlInline(node.summary)}</summary>${node.children.map(htmlBlock).join("")}</details>`;
    case "codeBlock": return `<pre${anchor}><code${node.language ? ` class="language-${escapeHtml(node.language)}"` : ""}>${escapeHtml(node.text)}</code></pre>`;
    case "diagram": return `<pre class="yuque-diagram" data-diagram-kind="${escapeHtml(node.kind || "diagram")}"${anchor}><code>${escapeHtml(node.source)}</code></pre>`;
    case "formula": return `<div class="math math-block"${anchor}>${escapeHtml(node.text)}</div>`;
    case "thematicBreak": return "<hr>";
    case "embed": {
      const url = outputUrl(node.url);
      return `<aside class="yuque-embed"${anchor}>嵌入内容：${url ? `<a href="${escapeHtml(url)}">${escapeHtml(node.title || url)}</a>` : escapeHtml(node.title || "无地址")}${node.description ? `<p>${escapeHtml(node.description)}</p>` : ""}</aside>`;
    }
    case "attachment": {
      const url = outputUrl(node.url);
      return `<p class="yuque-attachment"${anchor}>附件：${url ? `<a href="${escapeHtml(url)}">${escapeHtml(node.name || url)}</a>` : escapeHtml(node.name || "无地址")}</p>`;
    }
    case "media": {
      const url = outputUrl(node.url);
      return `<p class="yuque-media"${anchor}>${escapeHtml(node.kind || "媒体")}：${url ? `<a href="${escapeHtml(url)}">${escapeHtml(node.title || url)}</a>` : escapeHtml(node.title || "无地址")}</p>`;
    }
    case "image": return `<figure${anchor}>${htmlInline([node])}</figure>`;
    case "unknownCard": {
      const links = (node.links || []).map(outputUrl).filter(Boolean);
      return `<aside class="yuque-card-placeholder" data-card-name="${escapeHtml(node.name || "unknown")}"${anchor}>语雀卡片：${escapeHtml(node.name || "unknown")}；${escapeHtml(node.summary || "无摘要")}${links.length ? `<ul>${links.map((link) => `<li><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></li>`).join("")}</ul>` : ""}</aside>`;
    }
    default: return "";
  }
}

function markdownBlock(node, depth = 0) {
  switch (node.type) {
    case "paragraph": return markdownInline(node.children);
    case "heading": return `${node.anchor ? `<a id="${node.anchor}"></a>\n` : ""}${"#".repeat(node.level)} ${markdownInline(node.children)}`;
    case "list": return node.items.map((item, index) => {
      const marker = node.ordered ? `${(node.start || 1) + index}.` : "-";
      const check = item.checked == null ? "" : `[${item.checked ? "x" : " "}] `;
      const rendered = item.children.map((child) => markdownBlock(child, depth + 1)).join("\n\n");
      const lines = rendered.split("\n");
      return `${marker} ${check}${lines[0] || ""}${lines.slice(1).map((line) => `\n   ${line}`).join("")}`;
    }).join("\n");
    case "quote": return indentLines(node.children.map((child) => markdownBlock(child, depth)).join("\n\n"), "> ");
    case "alert": return `> [!${String(node.kind || "NOTE").toLocaleUpperCase("en-US")}]\n${indentLines(node.children.map((child) => markdownBlock(child, depth)).join("\n\n"), "> ")}`;
    case "table": {
      if (!tableIsSimple(node)) return htmlBlock(node);
      const rows = node.rows.map((row) => row.cells.map((cell) => markdownInline(cell.children[0]?.children || []).replace(/\|/gu, "\\|")));
      const header = rows[0];
      return [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`, ...rows.slice(1).map((row) => `| ${row.join(" | ")} |`)].join("\n");
    }
    case "details": return htmlBlock(node);
    case "codeBlock": {
      const fence = codeFence(node.text);
      return `${fence}${node.language || ""}\n${node.text || ""}\n${fence}`;
    }
    case "diagram": {
      const fence = codeFence(node.source);
      const language = String(node.kind || "").toLocaleLowerCase("en-US").includes("mermaid") ? "mermaid" : node.kind || "diagram";
      return `${fence}${language}\n${node.source || ""}\n${fence}`;
    }
    case "formula": return `$$\n${node.text || ""}\n$$`;
    case "thematicBreak": return "---";
    case "embed": {
      const url = outputUrl(node.url);
      return `> 嵌入内容：${url ? `[${escapeMarkdown(node.title || url)}](${url})` : escapeMarkdown(node.title || "无地址")}${node.description ? `\n> ${escapeMarkdown(node.description)}` : ""}`;
    }
    case "attachment": {
      const url = outputUrl(node.url);
      return `附件：${url ? `[${escapeMarkdown(node.name || url)}](${url})` : escapeMarkdown(node.name || "无地址")}`;
    }
    case "media": {
      const url = outputUrl(node.url);
      return `${escapeMarkdown(node.kind || "媒体")}：${url ? `[${escapeMarkdown(node.title || url)}](${url})` : escapeMarkdown(node.title || "无地址")}`;
    }
    case "image": return markdownInline([node]);
    case "unknownCard": {
      const links = (node.links || []).map(outputUrl).filter(Boolean);
      return `> ［语雀卡片：${escapeMarkdown(node.name || "unknown")}］${escapeMarkdown(node.summary || "无摘要")}${links.map((link) => `\n> ${link}`).join("")}`;
    }
    default: return "";
  }
}

function resultOf(input) {
  if (input?.document?.blocks) return input;
  if (input?.blocks) return { schemaVersion: SCHEMA_VERSION, document: input, diagnostics: [], stats: {} };
  throw new Error("序列化输入不是 ParsedDocument");
}

export function serializeMarkdown(input) {
  const result = resultOf(input);
  const body = result.document.blocks.map((block) => markdownBlock(block)).filter(Boolean).join("\n\n").trim();
  const title = result.document.source?.scope === "selection" ? "" : `# ${escapeMarkdown(result.document.title)}\n\n`;
  return `${title}${body}${body ? "\n" : ""}`;
}

const DOCUMENT_STYLE = `
body{max-width:920px;margin:40px auto;padding:0 24px;color:#17211b;font:16px/1.75 system-ui,sans-serif}
img{max-width:100%;height:auto}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccd6cf;padding:.45rem .6rem;vertical-align:top}
pre{overflow:auto;padding:1rem;background:#f4f7f5;border-radius:.5rem}code{font-family:ui-monospace,monospace}blockquote,.yuque-alert,.yuque-card-placeholder,.yuque-embed{margin:1rem 0;padding:.7rem 1rem;border-left:4px solid #72a989;background:#f4f8f5}
.yuque-label{display:inline-block;padding:.05rem .45rem;border-radius:999px;background:#e8f3ec}.math{white-space:pre-wrap;font-family:ui-monospace,monospace}details{margin:1rem 0}
`;

export function serializeHtml(input, options = {}) {
  const result = resultOf(input);
  const body = result.document.blocks.map(htmlBlock).join("");
  const title = result.document.source?.scope === "selection" ? "" : `<h1>${escapeHtml(result.document.title)}</h1>`;
  const fragment = `<article data-yuque-source="${escapeHtml(result.document.source?.kind || "unknown")}">${title}${body}</article>`;
  const renderedFragment = options.blockNetwork
    ? fragment.replace(/<img\b[^>]*\balt="([^"]*)"[^>]*>/gu, '<span class="blocked-image">［图片：$1；预览不加载远程资源］</span>')
    : fragment;
  if (options.standalone === false) return renderedFragment;
  const csp = options.blockNetwork
    ? '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:">'
    : "";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${csp}<title>${escapeHtml(result.document.title)}</title><style>${DOCUMENT_STYLE}</style></head><body>${renderedFragment}</body></html>`;
}

export function serializeJson(input) {
  return `${JSON.stringify(resultOf(input), null, 2)}\n`;
}

export function safeFilename(value, fallback = "yuque-document") {
  const cleaned = String(value || "")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/gu, "-")
    .replace(/[.\s]+$/gu, "")
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}
