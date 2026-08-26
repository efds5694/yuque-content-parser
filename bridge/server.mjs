import http from "node:http";
import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateRevisionRequest,
  validateRevisionResponse,
} from "../extension/lib/protocol.js";
import { buildPrompt } from "./prompt.mjs";

export const VERSION = "0.1.3";
export const DEFAULT_PORT = 32145;
const MAX_BODY_BYTES = 1_500_000;
const MAX_STDOUT_BYTES = 2_000_000;
const MAX_STDERR_BYTES = 100_000;
const CODEX_TIMEOUT_MS = 300_000;
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.dirname(scriptDirectory);

function allowedOrigin(origin) {
  return typeof origin === "string" && /^(chrome|edge)-extension:\/\/[a-p]{32}$/u.test(origin);
}

function tokenMatches(received, expected) {
  if (typeof received !== "string" || typeof expected !== "string") return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function tokenFilePath() {
  if (process.env.YUQUE_AI_TOKEN_FILE) return path.resolve(process.env.YUQUE_AI_TOKEN_FILE);
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "YuqueAIEditor", "bridge-token");
  }
  return path.join(os.homedir(), ".config", "yuque-ai-editor", "bridge-token");
}

export function loadOrCreateToken() {
  if (process.env.YUQUE_AI_TOKEN) return process.env.YUQUE_AI_TOKEN.trim();
  const filename = tokenFilePath();
  try {
    const existing = readFileSync(filename, "utf8").trim();
    if (/^[a-f0-9]{48}$/u.test(existing)) return existing;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const token = randomBytes(24).toString("hex");
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(filename, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  return token;
}

function parseWslUnc(value) {
  if (!value) return null;
  const normalized = String(value).replace(/\//gu, "\\");
  const match = normalized.match(/^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)\\(.*)$/iu);
  if (!match) return null;
  return {
    distro: match[1],
    linuxPath: `/${match[2].replace(/\\/gu, "/").replace(/^\/+|\/+$/gu, "")}`,
  };
}

export function resolveRunnerSpec(environment = process.env, platform = process.platform) {
  if (platform !== "win32") {
    return {
      command: "bash",
      argsPrefix: [path.join(scriptDirectory, "run-codex.sh"), path.join(scriptDirectory, "revision-schema.json")],
      description: "WSL/Linux",
    };
  }

  const configuredProject = environment.YUQUE_AI_WSL_PROJECT?.replace(/\\/gu, "/").replace(/\/$/u, "");
  const inferred = parseWslUnc(environment.YUQUE_AI_PROJECT_WIN)
    || parseWslUnc(projectDirectory);
  const distro = environment.YUQUE_AI_WSL_DISTRO || inferred?.distro || "Ubuntu";
  const linuxProject = configuredProject || inferred?.linuxPath;
  if (!linuxProject) {
    throw new Error("无法把项目路径转换为 WSL 路径。请设置 YUQUE_AI_WSL_PROJECT，例如 /home/用户名/语雀AI编辑器。");
  }
  const argsPrefix = ["-d", distro];
  if (environment.YUQUE_AI_WSL_USER) argsPrefix.push("-u", environment.YUQUE_AI_WSL_USER);
  argsPrefix.push(
    "--",
    "bash",
    "--noprofile",
    "--norc",
    `${linuxProject}/bridge/run-codex.sh`,
    `${linuxProject}/bridge/revision-schema.json`,
  );
  return { command: "wsl.exe", argsPrefix, description: `WSL ${distro}` };
}

function parseCodexOutput(stdout) {
  const text = stdout.trim();
  if (!text) throw new Error("Codex 没有返回结果");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Codex 返回了无法解析的 JSON");
  }
}

export function runCodex(request, options = {}) {
  if (process.env.YUQUE_AI_MOCK_RESPONSE_FILE) {
    return Promise.resolve(JSON.parse(readFileSync(process.env.YUQUE_AI_MOCK_RESPONSE_FILE, "utf8")));
  }
  const runner = options.runner || resolveRunnerSpec();
  const spawnImpl = options.spawnImpl || spawn;
  const timeoutMs = options.timeoutMs || CODEX_TIMEOUT_MS;
  const prompt = buildPrompt();

  return new Promise((resolve, reject) => {
    const child = spawnImpl(runner.command, [...runner.argsPrefix, prompt], {
      cwd: process.platform === "win32" ? (process.env.SystemRoot || "C:\\Windows") : projectDirectory,
      env: process.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error("Codex 审阅超过 5 分钟，已停止等待")));
    }, timeoutMs);

    child.on("error", (error) => finish(() => reject(new Error(`无法启动 Codex：${error.message}`))));
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout) > MAX_STDOUT_BYTES) {
        child.kill();
        finish(() => reject(new Error("Codex 返回内容超过安全上限")));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-MAX_STDERR_BYTES);
    });
    child.on("close", (code) => finish(() => {
      if (code !== 0) {
        const detail = stderr.trim().split(/\r?\n/u).slice(-8).join("\n");
        reject(new Error(`Codex 执行失败（退出码 ${code}）${detail ? `：\n${detail}` : ""}`));
        return;
      }
      try { resolve(parseCodexOutput(stdout)); }
      catch (error) { reject(error); }
    }));
    child.stdin.on("error", (error) => finish(() => reject(new Error(`无法向 Codex 发送文档：${error.message}`))));
    child.stdin.end(JSON.stringify(request));
  });
}

function jsonResponse(response, status, body, origin = "") {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (allowedOrigin(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers.Vary = "Origin";
  }
  response.writeHead(status, headers);
  response.end(JSON.stringify(body));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let tooLarge = false;
    request.on("data", (chunk) => {
      if (tooLarge) return;
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        tooLarge = true;
        reject(Object.assign(new Error("请求体超过安全上限"), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (tooLarge) return;
      if (bytes === 0) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(Object.assign(new Error("请求体不是有效 JSON"), { statusCode: 400 })); }
    });
    request.on("error", reject);
  });
}

function bearerToken(request) {
  const match = String(request.headers.authorization || "").match(/^Bearer\s+(.+)$/iu);
  return match?.[1] || "";
}

export function createBridgeServer(options = {}) {
  const token = options.token || loadOrCreateToken();
  const run = options.run || runCodex;
  let running = false;

  return http.createServer(async (request, response) => {
    const origin = String(request.headers.origin || "");
    if (request.method === "OPTIONS") {
      if (!allowedOrigin(origin)) return jsonResponse(response, 403, { error: "不允许的请求来源" });
      response.writeHead(204, {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Max-Age": "600",
        Vary: "Origin",
      });
      return response.end();
    }
    if (request.method === "GET" && request.url === "/health") {
      return jsonResponse(response, 200, { ok: true, version: VERSION, busy: running }, origin);
    }
    if (!allowedOrigin(origin)) return jsonResponse(response, 403, { error: "请求不是来自 Edge 扩展" });
    if (!tokenMatches(bearerToken(request), token)) return jsonResponse(response, 401, { error: "配对码无效" }, origin);
    if (request.method === "POST" && request.url === "/v1/pair") {
      return jsonResponse(response, 200, { ok: true, version: VERSION }, origin);
    }
    if (request.method !== "POST" || request.url !== "/v1/revise") {
      return jsonResponse(response, 404, { error: "接口不存在" }, origin);
    }
    if (running) return jsonResponse(response, 429, { error: "Codex 正在处理上一份文档" }, origin);

    running = true;
    try {
      const input = await readJsonBody(request);
      const validatedRequest = validateRevisionRequest(input);
      const rawRevision = await run(validatedRequest);
      const revision = validateRevisionResponse(rawRevision, validatedRequest);
      return jsonResponse(response, 200, revision, origin);
    } catch (error) {
      const status = error?.statusCode || 400;
      return jsonResponse(response, status, { error: error?.message || String(error) }, origin);
    } finally {
      running = false;
    }
  });
}

function printStartup(port, token) {
  const tokenHash = createHash("sha256").update(token).digest("hex").slice(0, 8);
  console.log("");
  console.log("  语雀 AI 编辑器本地服务已启动");
  console.log(`  地址：   http://127.0.0.1:${port}`);
  console.log(`  配对码： ${token}`);
  console.log(`  标识：   ${tokenHash}`);
  console.log("");
  console.log("  请保持此窗口开启。按 Ctrl+C 停止服务。");
  console.log("  文档正文不会写入日志，服务只接受本机 Edge 扩展请求。");
  console.log("");
}

export function startServer() {
  const port = Number(process.env.YUQUE_AI_PORT || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) throw new Error("YUQUE_AI_PORT 必须是 1024–65535 之间的端口");
  const token = loadOrCreateToken();
  const server = createBridgeServer({ token });
  server.on("error", (error) => {
    if (error?.code === "EADDRINUSE") console.error(`端口 ${port} 已被占用；本地服务可能已经启动。`);
    else console.error(error);
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => printStartup(port, token));
  return server;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) startServer();
