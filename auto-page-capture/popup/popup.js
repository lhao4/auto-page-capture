const $ = (id) => document.getElementById(id);
const MSG = window.APC.MSG;
const UNKNOWN_SESSION_ID = "无";
const CONTENT_SCRIPT_FILES = ["utils/common.js", "content/content.js"];
const DEFAULT_SETTINGS = {
  mode: "scrollOnly",
  delayMs: 800,
  maxShots: 120,
  maxPages: 5,
  exportText: true,
  exportPdf: true,
  pdfSinglePage: true,
  ocrEnabled: false,
  ocrLanguage: "chs",
  ocrApiKey: ""
};
const SETTINGS_FIELD_IDS = [
  "mode",
  "delay",
  "maxShots",
  "maxPages",
  "exportText",
  "exportPdf",
  "pdfSinglePage",
  "ocrEnabled",
  "ocrLanguage",
  "ocrApiKey"
];

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
  const sessionId = normalizeSessionId(viewState.sessionId);
  const statusText = viewState.status || "-";
  const errorText = viewState.error || "-";
  const hasError = Boolean(viewState.error);

  $("statusSessionId").textContent = sessionId;
  $("statusText").textContent = statusText;
  $("statusError").textContent = errorText;
  $("statusPanel").classList.toggle("has-error", hasError);
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

function clampNumber(v, fallback, min) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, n);
}

function updateOcrFieldsEnabled() {
  const enabled = $("ocrEnabled").checked;
  $("ocrLanguage").disabled = !enabled;
  $("ocrApiKey").disabled = !enabled;
}

function updatePdfFieldsEnabled() {
  const enabled = $("exportPdf").checked;
  $("pdfSinglePage").disabled = !enabled;
}

function readFormSettings() {
  return {
    mode: $("mode").value || DEFAULT_SETTINGS.mode,
    delayMs: clampNumber($("delay").value, DEFAULT_SETTINGS.delayMs, 100),
    maxShots: clampNumber($("maxShots").value, DEFAULT_SETTINGS.maxShots, 1),
    maxPages: clampNumber($("maxPages").value, DEFAULT_SETTINGS.maxPages, 1),
    exportText: $("exportText").checked,
    exportPdf: $("exportPdf").checked,
    pdfSinglePage: $("pdfSinglePage").checked,
    ocrEnabled: $("ocrEnabled").checked,
    ocrLanguage: $("ocrLanguage").value || DEFAULT_SETTINGS.ocrLanguage,
    ocrApiKey: String($("ocrApiKey").value || "").trim()
  };
}

function applyFormSettings(settings = {}) {
  const merged = {
    ...DEFAULT_SETTINGS,
    ...(settings || {})
  };

  $("mode").value = merged.mode;
  $("delay").value = clampNumber(merged.delayMs, DEFAULT_SETTINGS.delayMs, 100);
  $("maxShots").value = clampNumber(merged.maxShots, DEFAULT_SETTINGS.maxShots, 1);
  $("maxPages").value = clampNumber(merged.maxPages, DEFAULT_SETTINGS.maxPages, 1);
  $("exportText").checked = !!merged.exportText;
  $("exportPdf").checked = merged.exportPdf !== false;
  $("pdfSinglePage").checked = merged.pdfSinglePage !== false;
  $("ocrEnabled").checked = !!merged.ocrEnabled;
  $("ocrLanguage").value = merged.ocrLanguage || DEFAULT_SETTINGS.ocrLanguage;
  $("ocrApiKey").value = String(merged.ocrApiKey || "");
  updatePdfFieldsEnabled();
  updateOcrFieldsEnabled();
}

async function loadSettings() {
  try {
    const saved = await chrome.storage.local.get(DEFAULT_SETTINGS);
    applyFormSettings(saved);
  } catch (_e) {
    applyFormSettings(DEFAULT_SETTINGS);
  }
}

async function saveSettings(settings) {
  await chrome.storage.local.set(settings);
}

function persistCurrentSettings() {
  const settings = readFormSettings();
  saveSettings(settings).catch(() => {});
}

function bindSettingsEvents() {
  SETTINGS_FIELD_IDS.forEach((id) => {
    const el = $(id);
    if (!el) return;
    const eventName = id === "ocrApiKey" ? "input" : "change";
    el.addEventListener(eventName, () => {
      if (id === "exportPdf") updatePdfFieldsEnabled();
      if (id === "ocrEnabled") updateOcrFieldsEnabled();
      persistCurrentSettings();
    });
  });
}

$("start").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab?.id) return;

  const sessionId = window.APC.nowSessionId();
  const settings = readFormSettings();
  applyFormSettings(settings);
  saveSettings(settings).catch(() => {});

  const payload = {
    mode: settings.mode,
    delayMs: settings.delayMs,
    maxShots: settings.maxShots,
    maxPages: settings.maxPages,
    exportText: settings.exportText,
    exportPdf: settings.exportPdf,
    pdfSinglePage: settings.pdfSinglePage,
    ocrEnabled: settings.ocrEnabled,
    ocrLanguage: settings.ocrLanguage,
    ocrApiKey: settings.ocrApiKey
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

async function init() {
  renderStatus();
  bindSettingsEvents();
  await loadSettings();
}

init();
