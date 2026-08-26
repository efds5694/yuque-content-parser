import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const manifestPath = path.join(root, "extension", "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const startScript = readFileSync(path.join(root, "start.cmd"));
const contentScript = readFileSync(path.join(root, "extension", "content.js"), "utf8");
const referenced = [
  manifest.background?.service_worker,
  manifest.side_panel?.default_path,
  ...manifest.content_scripts.flatMap((entry) => entry.js || []),
].filter(Boolean);

for (const filename of referenced) {
  readFileSync(path.join(root, "extension", filename));
}

if (manifest.manifest_version !== 3) throw new Error("扩展必须使用 Manifest V3");
if (manifest.permissions.includes("cookies")) throw new Error("扩展不得申请 cookies 权限");
if (!manifest.permissions.includes("debugger")) throw new Error("缺少可信输入所需的 debugger 权限");
if (!manifest.permissions.includes("webNavigation")) throw new Error("缺少跨框架发现编辑器所需的 webNavigation 权限");
if (!manifest.content_scripts.every((entry) => entry.all_frames === true)) {
  throw new Error("语雀编辑器可能位于 iframe，content script 必须启用 all_frames");
}
if (startScript.toString("binary").replace(/\r\n/gu, "").includes("\n")) {
  throw new Error("start.cmd 必须使用 Windows CRLF 换行");
}
for (const selector of ["ne-p", "ne-h1", "ne-tli", "ne-uli-i", "ne-oli-i", "ne-text", "ne-card", "ne-b-filler"]) {
  if (!contentScript.toLowerCase().includes(selector)) throw new Error(`缺少新版语雀节点选择器：${selector}`);
}

await import(pathToFileURL(path.join(root, "extension", "lib", "protocol.js")));
await import(pathToFileURL(path.join(root, "extension", "lib", "diff.js")));
await import(pathToFileURL(path.join(root, "bridge", "server.mjs")));

console.log(`扩展清单有效，已检查 ${referenced.length} 个入口文件。`);
