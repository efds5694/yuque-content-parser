import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const extensionRoot = path.join(root, "extension");
const manifest = JSON.parse(readFileSync(path.join(extensionRoot, "manifest.json"), "utf8"));
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const contentScript = readFileSync(path.join(extensionRoot, "content.js"), "utf8");
const inlineScript = readFileSync(path.join(extensionRoot, "inline-ui.js"), "utf8");
const backgroundScript = readFileSync(path.join(extensionRoot, "background.js"), "utf8");
const panelScript = readFileSync(path.join(extensionRoot, "sidepanel.js"), "utf8");
const extensionJavascript = [contentScript, inlineScript, backgroundScript, panelScript,
  readFileSync(path.join(extensionRoot, "lib", "parser.js"), "utf8"),
  readFileSync(path.join(extensionRoot, "lib", "serializers.js"), "utf8")].join("\n");

const referenced = [
  manifest.background?.service_worker,
  ...manifest.content_scripts.flatMap((entry) => entry.js || []),
].filter(Boolean);
for (const filename of referenced) readFileSync(path.join(extensionRoot, filename));

if (manifest.manifest_version !== 3) throw new Error("扩展必须使用 Manifest V3");
if (manifest.name !== "语雀内容解析器") throw new Error("扩展名称尚未完成转型");
if (manifest.version !== packageJson.version) throw new Error("Manifest 与 package.json 版本不一致");

const forbiddenPermissions = ["cookies", "debugger", "storage", "webNavigation", "activeTab", "tabs"];
for (const permission of forbiddenPermissions) {
  if (manifest.permissions?.includes(permission)) throw new Error(`只读解析器不应申请 ${permission} 权限`);
}
for (const permission of ["clipboardWrite", "scripting"]) {
  if (!manifest.permissions?.includes(permission)) throw new Error(`缺少必要权限：${permission}`);
}
if (manifest.optional_host_permissions?.length) throw new Error("解析器不应申请可选外部主机权限");
if ((manifest.host_permissions || []).some((pattern) => !pattern.includes("yuque.com/"))) {
  throw new Error("主机权限只能覆盖语雀页面");
}
if (!manifest.content_scripts.every((entry) => entry.all_frames === true)) {
  throw new Error("语雀正文可能位于 iframe，content script 必须启用 all_frames");
}

for (const selector of ["ne-p", "ne-h1", "ne-tli", "ne-table", "ne-card", "doc-reader-content"]) {
  if (!contentScript.toLocaleLowerCase("en-US").includes(selector)) throw new Error(`缺少语雀页面选择器：${selector}`);
}
if (!contentScript.includes('type: "PARSE_PROGRESS"') || !contentScript.includes("PARSE_PAGE:")) {
  throw new Error("网页扫描消息链路不完整");
}
if (!inlineScript.includes("attachShadow") || !inlineScript.includes("sidepanel.html?inline=1")) {
  throw new Error("页内 Shadow DOM 抽屉入口不完整");
}
if (!panelScript.includes("parseLake") || !panelScript.includes('type: "PARSE_PAGE"') || !panelScript.includes('type: "GET_CURRENT_LAKE"')) {
  throw new Error("抽屉没有接通当前 Lake、文件 Lake 与页面入口");
}
if (!inlineScript.includes('frame.allow = "clipboard-write"') || !panelScript.includes("fallbackCopyText")) {
  throw new Error("页内抽屉缺少剪贴板权限声明或降级复制路径");
}
if (!backgroundScript.includes('world: "MAIN"') || !backgroundScript.includes("/api/docs/") || !backgroundScript.includes('credentials: "include"')) {
  throw new Error("一键 Lake 读取必须在语雀主环境中复用当前登录态");
}

const forbiddenRuntimePatterns = [
  "chrome.debugger", "Input.insertText", "APPLY_OPERATIONS", "GENERATE_REVISION", "GET_PROVIDER_CONFIG",
  "OPENAI_COMPATIBLE", "codex_cli", "127.0.0.1",
];
for (const pattern of forbiddenRuntimePatterns) {
  if (extensionJavascript.includes(pattern)) throw new Error(`仍残留旧编辑器或网络运行时代码：${pattern}`);
}

const resourceEntries = manifest.web_accessible_resources || [];
const webResources = resourceEntries.flatMap((entry) => entry.resources || []);
for (const resource of ["sidepanel.html", "sidepanel.css", "sidepanel.js", "lib/*.js"]) {
  if (!webResources.includes(resource)) throw new Error(`页内抽屉缺少可访问资源：${resource}`);
}
if (resourceEntries.some((entry) => (entry.matches || []).some((match) => !match.includes("yuque.com/")))) {
  throw new Error("页内 iframe 资源只能允许语雀页面加载");
}

for (const legacyPath of ["start.cmd", "bridge/server.mjs", "bridge/run-codex.sh", "extension/lib/provider.js", "extension/lib/diff.js", "extension/lib/protocol.js"]) {
  if (existsSync(path.join(root, legacyPath))) throw new Error(`旧 AI 编辑链路尚未移除：${legacyPath}`);
}

await import(pathToFileURL(path.join(extensionRoot, "lib", "parser.js")));
await import(pathToFileURL(path.join(extensionRoot, "lib", "serializers.js")));

const fetchCalls = extensionJavascript.match(/\bfetch\s*\(/gu) || [];
if (fetchCalls.length !== 1) throw new Error(`只允许一处语雀同源 Lake 读取，当前发现 ${fetchCalls.length} 处 fetch`);

console.log(`扩展清单有效，已检查 ${referenced.length} 个入口文件；仅包含语雀同源 Lake 读取，不含 AI 或写回链路。`);
