import { test, expect, chromium } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const extensionPath = path.join(projectRoot, "extension");
const pageFixturePath = path.join(projectRoot, "e2e", "fixtures", "yuque-editor.html");
const lakeFixturePath = path.join(projectRoot, "e2e", "fixtures", "semantic.lake");

let context;
let serviceWorker;
let userDataDir;

test.beforeAll(async () => {
  userDataDir = await mkdtemp(path.join(os.tmpdir(), "yuque-parser-playwright-"));
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    acceptDownloads: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  serviceWorker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
});

test.afterAll(async () => {
  await context?.close();
  if (userDataDir) await rm(userDataDir, { recursive: true, force: true });
});

async function openFixture(slug = "document") {
  const fixture = await readFile(pageFixturePath, "utf8");
  const lake = await readFile(lakeFixturePath, "utf8");
  const page = await context.newPage();
  await page.route("https://www.yuque.com/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/api/docs/")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify({ data: { title: "语义解析样例", content: lake } }),
      });
    }
    return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: fixture });
  });
  await page.goto(`https://www.yuque.com/test/book/${slug}`);
  await expect(page.locator("#yuque-parser-inline-host")).toHaveCount(1);
  return page;
}

function launcher(page) {
  return page.locator("#yuque-parser-inline-host").locator("[data-testid=yuque-parser-launcher]");
}

function drawer(page) {
  return page.locator("#yuque-parser-inline-host").locator("[data-testid=yuque-parser-drawer]");
}

function panel(page) {
  return page.frameLocator("#yuque-parser-inline-host iframe");
}

async function selectBoldSubstring(page) {
  await page.locator("#t3").evaluate((element) => {
    const text = element.firstChild;
    const range = document.createRange();
    range.setStart(text, 1);
    range.setEnd(text, 3);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
}

test("精确选区保留字符边界和行内语义，关闭抽屉后结果仍在", async () => {
  const page = await openFixture("selection");
  await selectBoldSubstring(page);
  await launcher(page).click();
  await expect(drawer(page)).toHaveClass(/open/u);

  const ui = panel(page);
  const sourceDebug = await ui.locator("#sourcePage").evaluate((input) => {
    let changes = 0;
    input.addEventListener("change", () => { changes += 1; });
    input.click();
    return { checked: input.checked, changes, selected: document.querySelector('input[name="source"]:checked')?.value };
  });
  console.log("source radio immediate", sourceDebug);
  await page.waitForTimeout(200);
  console.log("source radio delayed", await ui.locator("body").evaluate(() => ({
    selected: document.querySelector('input[name="source"]:checked')?.value,
    href: location.href,
  })));
  await expect(ui.locator("#sourcePage")).toBeChecked();
  await expect(ui.locator("#pageBadge")).toHaveText("页面可读");
  await expect(ui.locator("#selectionHint")).toContainText("已捕获 2 个字符");
  await ui.locator("#parseButton").click();
  await expect(ui.locator("#workStatus")).toContainText("解析完成");
  await expect(ui.locator("#fidelityBadge")).toHaveText("页面尽力提取");
  await expect(ui.locator("#textPreview")).toHaveText("**粗文**");
  await expect(page.locator("#t3")).toHaveText("加粗文字");

  await ui.locator("#closeButton").click();
  await expect(drawer(page)).not.toHaveClass(/open/u);
  await launcher(page).click();
  await expect(ui.locator("#textPreview")).toHaveText("**粗文**");
  await page.close();
});

test("阅读态全文扫描保留高级结构并恢复滚动位置", async () => {
  const page = await openFixture("document-scan");
  await page.locator(".ne-engine").evaluate((root) => root.setAttribute("contenteditable", "false"));
  await page.evaluate(() => window.scrollTo(0, 220));
  const before = await page.evaluate(() => window.scrollY);
  await launcher(page).click();
  const ui = panel(page);
  await ui.locator(".source-option").nth(1).click();
  await expect(ui.locator("#sourcePage")).toBeChecked();
  await ui.locator(".segmented label").nth(1).click();
  await expect(ui.locator('input[name="scope"][value="document"]')).toBeChecked();
  await ui.locator("#parseButton").click();
  await expect(ui.locator("#workStatus")).toContainText("解析完成");
  const markdown = await ui.locator("#textPreview").textContent();
  expect(markdown).toContain("# 脱敏测试文档");
  expect(markdown).toContain("## 一、 组织部负责人1");
  expect(markdown).toContain("- 1列表正文");
  expect(markdown).toContain("表格内容");
  expect(markdown).toContain("const protectedValue = true;");
  expect(markdown).toContain("折叠标题");
  expect(markdown).toContain("语雀卡片：diagram");
  const after = await page.evaluate(() => window.scrollY);
  expect(Math.abs(after - before)).toBeLessThanOrEqual(2);

  await ui.locator('[data-format="json"]').click();
  const parsed = JSON.parse(await ui.locator("#textPreview").textContent());
  expect(parsed.document.source).toMatchObject({ kind: "page", scope: "document", fidelity: "rendered" });
  expect(parsed.document.blocks.some((block) => block.type === "table")).toBe(true);
  expect(parsed.document.blocks.some((block) => block.type === "details")).toBe(true);
  expect(parsed.diagnostics.some((item) => item.code === "PAGE_RENDERED_SOURCE")).toBe(true);
  await page.close();
});

test("默认入口一键读取当前文档 Lake 并交给高保真解析器", async () => {
  const page = await openFixture("current-lake");
  const apiRequests = [];
  const onRequest = (request) => {
    if (request.url().includes("/api/docs/")) apiRequests.push(request.url());
  };
  context.on("request", onRequest);

  await launcher(page).click();
  const ui = panel(page);
  await expect(ui.locator("#sourceAuto")).toBeChecked();
  await expect(ui.locator("#parseButton")).toHaveText("一键解析当前文档");
  await ui.locator("#parseButton").click();
  await expect(ui.locator("#workStatus")).toContainText("解析完成");
  await expect(ui.locator("#fidelityBadge")).toHaveText("Lake 高保真");
  await expect(ui.locator("#textPreview")).toContainText("# 语义解析样例");
  expect(apiRequests).toHaveLength(1);
  expect(apiRequests[0]).toContain("/api/docs/current-lake");
  expect(apiRequests[0]).toContain("book_id=12345");
  expect(apiRequests[0]).toContain("merge_dynamic_data=false");

  context.off("request", onRequest);
  await page.close();
});

test("Lake 文件高保真解析、未知卡片 JSON 兜底、预览零网络并支持复制下载", async () => {
  const page = await openFixture("lake-import");
  const remoteRequests = [];
  const onRequest = (request) => {
    if (/cdn\.nlark\.com|\/api\//u.test(request.url())) remoteRequests.push(request.url());
  };
  context.on("request", onRequest);

  await launcher(page).click();
  const ui = panel(page);
  await ui.locator("#lakeFile").setInputFiles(lakeFixturePath);
  await ui.locator("#parseButton").click();
  await expect(ui.locator("#workStatus")).toContainText("解析完成");
  await expect(ui.locator("#fidelityBadge")).toHaveText("Lake 高保真");
  const markdown = await ui.locator("#textPreview").textContent();
  expect(markdown).toContain("# 语义解析样例");
  expect(markdown).toContain("[x] 完成解析");
  expect(markdown).toContain("```javascript");
  expect(markdown).toContain("```mermaid");
  expect(markdown).toContain("![架构图](https://cdn.nlark.com/yuque/test/image.png)");
  expect(markdown).toContain("附件.pdf");
  expect(markdown).toContain("E=mc^2");
  expect(markdown).toContain("语雀卡片：calendar");
  expect(markdown).not.toContain("json-only");

  await ui.locator('[data-format="json"]').click();
  const parsed = JSON.parse(await ui.locator("#textPreview").textContent());
  const unknown = parsed.document.blocks.find((block) => block.type === "unknownCard" && block.name === "calendar");
  expect(unknown.raw.privateState).toBe("json-only");
  expect(parsed.document.blocks.some((block) => block.type === "formula")).toBe(true);
  expect(parsed.document.blocks.some((block) => block.type === "attachment")).toBe(true);
  expect(await ui.locator("body").evaluate(() => globalThis.__lakeScriptExecuted)).toBeUndefined();

  await ui.locator("body").evaluate(() => {
    globalThis.__copiedText = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (value) => { globalThis.__copiedText = value; } },
    });
  });
  await ui.locator("#copyButton").click();
  expect(await ui.locator("body").evaluate(() => globalThis.__copiedText)).toContain('"schemaVersion": 1');

  await ui.locator("body").evaluate(() => {
    globalThis.__fallbackCopiedText = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => { throw new DOMException("blocked", "NotAllowedError"); } },
    });
    document.execCommand = () => {
      globalThis.__fallbackCopiedText = document.activeElement?.value || "";
      return true;
    };
  });
  await ui.locator("#copyButton").click();
  expect(await ui.locator("body").evaluate(() => globalThis.__fallbackCopiedText)).toContain('"schemaVersion": 1');
  await expect(ui.locator("#workStatus")).toContainText("已复制到剪贴板");

  await ui.locator('[data-format="html"]').click();
  await expect(ui.locator("#htmlPreview")).toBeVisible();
  await page.waitForTimeout(250);
  expect(remoteRequests).toEqual([]);

  await ui.locator('[data-format="markdown"]').click();
  const downloadPromise = page.waitForEvent("download");
  await ui.locator("#downloadButton").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("语义解析样例.md");

  context.off("request", onRequest);
  await page.close();
});

test("SPA 跳转会关闭抽屉并清除上一文档界面状态", async () => {
  const page = await openFixture("spa-before");
  await launcher(page).click();
  await expect(drawer(page)).toHaveClass(/open/u);
  await page.evaluate(() => history.pushState({}, "", "/test/book/spa-after"));
  await expect(drawer(page)).not.toHaveClass(/open/u, { timeout: 2_000 });
  await launcher(page).click();
  await expect(panel(page).locator("#resultSection")).toHaveClass(/hidden/u);
  await page.close();
});

test("Manifest 权限和服务 worker 不包含外部网络或写回能力", async () => {
  const manifest = await serviceWorker.evaluate(() => chrome.runtime.getManifest());
  expect(manifest.name).toBe("语雀内容解析器");
  expect(manifest.version).toBe("0.3.0");
  expect(manifest.permissions.sort()).toEqual(["clipboardWrite", "scripting"]);
  expect(manifest.optional_host_permissions).toBeUndefined();
  expect(manifest.host_permissions.every((pattern) => pattern.includes("yuque.com/"))).toBe(true);
});
