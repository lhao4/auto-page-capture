const $ = (id) => document.getElementById(id);
const MSG = window.APC.MSG;
const UNKNOWN_SESSION_ID = "无";
const CONTENT_SCRIPT_FILES = ["utils/common.js", "content/content.js"];

const viewState = {
  sessionId: UNKNOWN_SESSION_ID,
  status: "空闲",
  error: ""
};

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeSessionId(sessionId) {
  return sessionId ? String(sessionId) : UNKNOWN_SESSION_ID;
}

function formatRuntimeError(err) {
  const message = String(err?.message || err || "未知错误");
  if (message.includes("Receiving end does not exist")) {
    return "当前页面未注入脚本，已尝试自动修复，请再试一次。";
  }
  if (message.includes("Cannot access a chrome://")) {
    return "当前是浏览器内置页面（chrome://），该页面不支持扩展注入。";
  }
  if (message.includes("Cannot access contents of url")) {
    return "当前页面受限，扩展无权访问。请切换到普通网页。";
  }
  return message;
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        const errMsg = String(err.message || "");
        // Content script may not call sendResponse; this is still a successful delivery.
        if (errMsg.includes("The message port closed before a response was received")) {
          resolve(undefined);
          return;
        }
        reject(new Error(errMsg));
        return;
      }
      resolve(response);
    });
  });
}

async function ensureContentScriptReady(tabId) {
  try {
    await sendTabMessage(tabId, { type: "APC_PING", sessionId: UNKNOWN_SESSION_ID, payload: {} });
    return;
  } catch (e) {
    const message = String(e?.message || e || "");
    if (!message.includes("Receiving end does not exist")) {
      throw e;
    }
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: CONTENT_SCRIPT_FILES
  });
  await sleep(80);
  await sendTabMessage(tabId, { type: "APC_PING", sessionId: UNKNOWN_SESSION_ID, payload: {} });
}

function renderStatus() {
  const errorBlock = viewState.error || "-";
  $("status").textContent =
    `会话ID: ${normalizeSessionId(viewState.sessionId)}\n` +
    `状态: ${viewState.status || "-"}\n\n` +
    `错误:\n${errorBlock}`;
}

function patchViewState(patch) {
  if (Object.prototype.hasOwnProperty.call(patch, "sessionId")) {
    viewState.sessionId = normalizeSessionId(patch.sessionId);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "status")) {
    viewState.status = patch.status || "-";
  }
  if (Object.prototype.hasOwnProperty.call(patch, "error")) {
    viewState.error = patch.error || "";
  }
  renderStatus();
}

$("start").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab?.id) return;

  const sessionId = window.APC.nowSessionId();

  const payload = {
    mode: $("mode").value,
    delayMs: Number($("delay").value || 800),
    maxShots: Number($("maxShots").value || 120),
    maxPages: Number($("maxPages").value || 5),
    exportText: $("exportText").checked
  };

  patchViewState({ sessionId, status: "正在启动...", error: "" });
  try {
    await ensureContentScriptReady(tab.id);
    await sendTabMessage(tab.id, {
      type: MSG.START_CAPTURE,
      sessionId,
      payload
    });
  } catch (e) {
    patchViewState({
      status: "启动失败",
      error: formatRuntimeError(e)
    });
  }
});

$("stop").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab?.id) return;

  const sessionId = normalizeSessionId(viewState.sessionId);
  try {
    await ensureContentScriptReady(tab.id);
    await sendTabMessage(tab.id, {
      type: MSG.STOP_CAPTURE,
      sessionId,
      payload: {}
    });
    patchViewState({ status: "已请求停止。" });
  } catch (e) {
    patchViewState({
      status: "停止失败",
      error: formatRuntimeError(e)
    });
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg?.type) return;

  if (msg.type === MSG.STATUS) {
    patchViewState({
      sessionId: msg.sessionId,
      status: msg.payload?.text || "-"
    });
  }
  if (msg.type === MSG.ERROR) {
    patchViewState({
      sessionId: msg.sessionId,
      error: msg.payload?.message || "未知错误"
    });
  }
});

renderStatus();
