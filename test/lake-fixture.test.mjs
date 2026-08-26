import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("Lake 样例包含预期的复杂结构，保护策略有真实测试覆盖", () => {
  const lake = readFileSync(new URL("../团委组织部工作手册 副本.lake", import.meta.url), "utf8");
  assert.ok(lake.startsWith("<!doctype lake>"));
  assert.match(lake, /<table\b/u);
  assert.match(lake, /<details\b/u);
  assert.match(lake, /<card\b[^>]*name="codeblock"/u);
  assert.match(lake, /<card\b[^>]*name="diagram"/u);
  assert.match(lake, /<a\b[^>]*href=/u);
  const cards = lake.match(/<card\b/gu) || [];
  const lakeIds = Array.from(lake.matchAll(/data-lake-id="([^"]+)"/gu), (match) => match[1]);
  assert.equal(cards.length, 93);
  assert.equal(lakeIds.length, new Set(lakeIds).size, "Lake ID 必须保持唯一");
});
