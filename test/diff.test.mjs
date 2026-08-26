import test from "node:test";
import assert from "node:assert/strict";
import { applyHunks, diffSegments, diffToHunks } from "../extension/lib/diff.js";

const cases = [
  ["团委组织部", "校团委组织部"],
  ["请于3月1日提交材料。", "请于 3 月 1 日前提交完整材料。"],
  ["前缀相同，中间错误，末尾相同", "前缀相同，中间正确，末尾相同"],
  ["😀团务文档", "😀学校团务文档✨"],
  ["删除这一段多余文字", "删除文字"],
  ["abcXYZdefXYZghi", "abc123def456ghi"],
  ["", "新段落"],
  ["整段删除", ""],
];

test("字符差异可以重建目标文本", () => {
  for (const [before, after] of cases) {
    const hunks = diffToHunks(before, after);
    assert.equal(applyHunks(before, hunks), after, `${before} -> ${after}`);
    for (const hunk of hunks) assert.equal(before.slice(hunk.start, hunk.end), hunk.oldText);
  }
});

test("Myers 分段同时保留相同、删除和插入", () => {
  const segments = diffSegments("甲乙丙丁", "甲新丙末");
  assert.ok(segments.some((item) => item.type === "equal"));
  assert.ok(segments.some((item) => item.type === "delete"));
  assert.ok(segments.some((item) => item.type === "insert"));
});

test("随机短文本差异始终可逆向重建", () => {
  let seed = 20260822;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const alphabet = Array.from("甲乙丙丁ABC😀，。 ");
  for (let index = 0; index < 250; index += 1) {
    const make = () => Array.from({ length: Math.floor(random() * 18) }, () => alphabet[Math.floor(random() * alphabet.length)]).join("");
    const before = make();
    const after = make();
    assert.equal(applyHunks(before, diffToHunks(before, after)), after);
  }
});
