import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_LAKE_BYTES,
  SCHEMA_VERSION,
  decodeCardPayload,
  sanitizeUrl,
} from "../extension/lib/parser.js";

test("解析器公开稳定的 schema、文件上限和 Card value 解码器", () => {
  assert.equal(SCHEMA_VERSION, 1);
  assert.equal(MAX_LAKE_BYTES, 20 * 1024 * 1024);
  const value = `data:${encodeURIComponent(JSON.stringify({ label: "重要", url: "https://www.yuque.com/test" }))}`;
  assert.deepEqual(decodeCardPayload(value), {
    decoded: '{"label":"重要","url":"https://www.yuque.com/test"}',
    data: { label: "重要", url: "https://www.yuque.com/test" },
    error: "",
  });
  assert.equal(decodeCardPayload("data:%E0%A4%A").error, "malformed-percent-encoding");
  assert.equal(decodeCardPayload("data:not-json").error, "invalid-json");
});

test("URL 白名单拒绝脚本、blob 和危险 data URL", () => {
  assert.equal(sanitizeUrl("https://cdn.nlark.com/image.png"), "https://cdn.nlark.com/image.png");
  assert.equal(sanitizeUrl("#section"), "#section");
  assert.equal(sanitizeUrl("/group/book/doc"), "/group/book/doc");
  assert.equal(sanitizeUrl("mailto:test@example.com"), "mailto:test@example.com");
  assert.equal(sanitizeUrl("javascript:alert(1)"), "");
  assert.equal(sanitizeUrl("data:image/svg+xml,<svg onload=alert(1)>", { allowImageData: true }), "");
  assert.equal(sanitizeUrl("blob:https://www.yuque.com/secret"), "");
});
