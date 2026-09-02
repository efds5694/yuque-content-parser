import test from "node:test";
import assert from "node:assert/strict";
import {
  safeFilename,
  serializeHtml,
  serializeJson,
  serializeMarkdown,
} from "../extension/lib/serializers.js";

function fixtureResult() {
  return {
    schemaVersion: 1,
    document: {
      title: "测试/文档",
      source: { kind: "lake", scope: "document", fidelity: "source", fileName: "test.lake" },
      blocks: [
        { type: "heading", level: 2, anchor: "intro", children: [{ type: "text", text: "介绍" }] },
        { type: "paragraph", children: [
          { type: "text", text: "正文 " },
          { type: "strong", children: [{ type: "text", text: "重点" }] },
          { type: "image", url: "https://cdn.nlark.com/a.png", alt: "示意图" },
        ] },
        { type: "list", ordered: false, items: [
          { type: "listItem", checked: true, children: [{ type: "paragraph", children: [{ type: "text", text: "已完成" }] }] },
        ] },
        { type: "table", anchor: "complex-table", rows: [
          { type: "tableRow", cells: [{ type: "tableCell", header: true, rowspan: 1, colspan: 1, children: [{ type: "paragraph", children: [{ type: "text", text: "列" }] }] }] },
          { type: "tableRow", cells: [{ type: "tableCell", header: false, rowspan: 2, colspan: 1, children: [{ type: "paragraph", children: [{ type: "text", text: "合并" }] }] }] },
        ] },
        { type: "codeBlock", language: "text", text: "````\n代码" },
        { type: "diagram", kind: "mermaid", source: "graph TD\nA-->B" },
        { type: "unknownCard", name: "calendar", summary: "日历卡片", links: [], raw: { token: "仅在 JSON" } },
      ],
    },
    diagnostics: [{ severity: "warning", code: "UNKNOWN_CARD", message: "未知卡片" }],
    stats: { nodes: 20, characters: 20, images: 1, cards: 2, warnings: 1 },
  };
}

test("Markdown 精简输出标题、结构、复杂表格和动态代码围栏", () => {
  const markdown = serializeMarkdown(fixtureResult());
  assert.match(markdown, /^# 测试\/文档/mu);
  assert.match(markdown, /<a id="intro"><\/a>/u);
  assert.match(markdown, /\*\*重点\*\*/u);
  assert.match(markdown, /!\[示意图\]\(https:\/\/cdn\.nlark\.com\/a\.png\)/u);
  assert.match(markdown, /- \[x\] 已完成/u);
  assert.match(markdown, /<table\b/u, "合并单元格应降级为 HTML table");
  assert.match(markdown, /`````text\n````\n代码\n`````/u);
  assert.match(markdown, /```mermaid/u);
  assert.match(markdown, /语雀卡片：calendar/u);
  assert.doesNotMatch(markdown, /仅在 JSON/u);
});

test("HTML 是完整 UTF-8 语义文档，预览版阻止外部网络", () => {
  const html = serializeHtml(fixtureResult());
  assert.match(html, /^<!doctype html>/u);
  assert.match(html, /<meta charset="utf-8">/u);
  assert.match(html, /<table id=/u);
  assert.match(html, /rowspan="2"/u);
  assert.match(html, /<img src="https:\/\/cdn\.nlark\.com\/a\.png"/u);
  assert.doesNotMatch(html, /仅在 JSON/u);

  const preview = serializeHtml(fixtureResult(), { blockNetwork: true });
  assert.match(preview, /Content-Security-Policy/u);
  assert.match(preview, /default-src 'none'/u);
});

test("JSON 保留规范化结构、诊断和未知卡片元数据", () => {
  const json = JSON.parse(serializeJson(fixtureResult()));
  assert.equal(json.schemaVersion, 1);
  assert.equal(json.document.blocks.at(-1).raw.token, "仅在 JSON");
  assert.equal(json.diagnostics[0].code, "UNKNOWN_CARD");
  assert.equal(safeFilename('测试<>:"/\\|?*文档. '), "测试---------文档");
});
