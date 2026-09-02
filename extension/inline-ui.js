(() => {
  "use strict";

  if (window.top !== window || document.getElementById("yuque-parser-inline-host")) return;

  const host = document.createElement("div");
  host.id = "yuque-parser-inline-host";
  host.style.cssText = "all:initial;position:fixed;inset:0 0 auto auto;z-index:2147483647;pointer-events:none;";
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .launcher {
      position: fixed; right: 18px; bottom: 18px; width: 52px; height: 52px;
      border: 0; border-radius: 18px; color: #fff; background: #1f7a4d;
      box-shadow: 0 10px 30px rgba(20, 60, 38, .28); cursor: pointer;
      pointer-events: auto; font: 800 15px/1 "Segoe UI", "Microsoft YaHei", sans-serif;
      transition: transform .16s ease, background .16s ease, box-shadow .16s ease;
    }
    .launcher:hover { background: #155d3a; transform: translateY(-2px); box-shadow: 0 13px 34px rgba(20, 60, 38, .34); }
    .launcher:focus-visible { outline: 3px solid rgba(31, 122, 77, .25); outline-offset: 3px; }
    .launcher[aria-expanded="true"] { background: #155d3a; }
    .drawer {
      position: fixed; right: 16px; bottom: 82px; width: min(420px, calc(100vw - 24px));
      height: min(760px, calc(100vh - 104px)); overflow: hidden; border: 1px solid #dbe3dd;
      border-radius: 18px; background: #f3f6f2; box-shadow: 0 20px 60px rgba(16, 38, 25, .25);
      pointer-events: auto; opacity: 0; visibility: hidden; transform: translateY(12px) scale(.985);
      transform-origin: bottom right; transition: opacity .16s ease, transform .16s ease, visibility .16s;
    }
    .drawer.open { opacity: 1; visibility: visible; transform: translateY(0) scale(1); }
    iframe { display: block; width: 100%; height: 100%; border: 0; background: #f3f6f2; }
    @media (max-width: 540px) {
      .launcher { right: 12px; bottom: 12px; }
      .drawer { right: 6px; bottom: 72px; width: calc(100vw - 12px); height: calc(100vh - 82px); }
    }
    @media print { .launcher, .drawer { display: none !important; } }
  `;

  const launcher = document.createElement("button");
  launcher.type = "button";
  launcher.className = "launcher";
  launcher.textContent = "析";
  launcher.title = "打开语雀内容解析器";
  launcher.setAttribute("aria-label", "打开语雀内容解析器");
  launcher.setAttribute("aria-expanded", "false");
  launcher.dataset.testid = "yuque-parser-launcher";

  const drawer = document.createElement("div");
  drawer.className = "drawer";
  drawer.dataset.testid = "yuque-parser-drawer";
  let frame = null;
  let open = false;
  let capturePromise = null;

  function ensureFrame() {
    if (frame) return frame;
    frame = document.createElement("iframe");
    frame.title = "语雀内容解析器";
    frame.allow = "clipboard-write";
    frame.src = chrome.runtime.getURL("sidepanel.html?inline=1");
    frame.dataset.testid = "yuque-parser-panel-frame";
    drawer.append(frame);
    return frame;
  }

  function setOpen(next) {
    open = typeof next === "boolean" ? next : !open;
    if (open) ensureFrame();
    drawer.classList.toggle("open", open);
    launcher.setAttribute("aria-expanded", String(open));
    launcher.setAttribute("aria-label", open ? "关闭语雀内容解析器" : "打开语雀内容解析器");
    launcher.title = open ? "关闭语雀内容解析器" : "打开语雀内容解析器";
    return { open };
  }

  async function captureSelection() {
    try {
      const response = await chrome.runtime.sendMessage({ type: "CAPTURE_SELECTION" });
      return response?.ok ? response.value : { count: 0 };
    } catch {
      return { count: 0 };
    }
  }

  launcher.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    capturePromise = captureSelection();
  });
  launcher.addEventListener("click", async () => {
    await (capturePromise || captureSelection());
    capturePromise = null;
    setOpen();
  });

  shadow.append(style, drawer, launcher);
  document.documentElement.append(host);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "INLINE_PANEL_SET") return false;
    sendResponse({ ok: true, value: setOpen(message.open) });
    return false;
  });

  let lastDocumentKey = location.href.split(/[?#]/u)[0];
  setInterval(() => {
    const nextDocumentKey = location.href.split(/[?#]/u)[0];
    if (nextDocumentKey === lastDocumentKey) return;
    lastDocumentKey = nextDocumentKey;
    open = false;
    drawer.classList.remove("open");
    launcher.setAttribute("aria-expanded", "false");
    frame?.remove();
    frame = null;
    chrome.runtime.sendMessage({ type: "INLINE_DOCUMENT_CHANGED" }).catch(() => {});
  }, 500);
})();
