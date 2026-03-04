// background/service_worker.js (MV3)
// NOTE: service worker has no DOM/window.

const UNKNOWN_SESSION_ID = "无";
const MSG = {
  SESSION_INIT: "SESSION_INIT",
  SESSION_READY: "SESSION_READY",
  CAPTURE_REQUEST: "CAPTURE_REQUEST",
  CAPTURE_SAVED: "CAPTURE_SAVED",
  EXPORT_TEXT: "EXPORT_TEXT",
  EXPORT_SAVED: "EXPORT_SAVED",
  STATUS: "STATUS",
  ERROR: "ERROR",
  SESSION_FINISH: "SESSION_FINISH"
};

function safeName(s) {
  return String(s || "").replace(/[:/\\?*"<>|]/g, "_").slice(0, 120);
}
function pad(n, w = 3) {
  return String(n).padStart(w, "0");
}

const sessions = new Map(); // sessionId -> meta

async function captureVisible() {
  const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: "png" });
  if (!dataUrl) throw new Error("captureVisibleTab 返回了空数据");
  return dataUrl;
}

async function downloadDataUrl(dataUrl, filename) {
  await chrome.downloads.download({
    url: dataUrl,
    filename,
    saveAs: false
  });
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function downloadText(text, filename, mime = "text/plain;charset=utf-8") {
  const bytes = new TextEncoder().encode(String(text || ""));
  const base64 = bytesToBase64(bytes);
  const url = `data:${mime};base64,${base64}`;
  await chrome.downloads.download({ url, filename, saveAs: false });
}

function normalizeSessionId(sessionId) {
  return sessionId ? String(sessionId) : UNKNOWN_SESSION_ID;
}

function makeMessage(type, sessionId, payload = {}) {
  return {
    type,
    sessionId: normalizeSessionId(sessionId),
    payload: payload || {}
  };
}

function sendMessage(type, sessionId, payload = {}) {
  chrome.runtime.sendMessage(makeMessage(type, sessionId, payload));
}

function sendStatus(sessionId, text) {
  sendMessage(MSG.STATUS, sessionId, { text });
}

function sendError(sessionId, message) {
  appendSessionError(sessionId, message);
  sendMessage(MSG.ERROR, sessionId, { message });
}

function createSessionMeta(sessionId, baseDir, host, tabUrl, payload = {}) {
  return {
    sessionId,
    baseDir,
    host,
    url: tabUrl,
    title: payload.title || "",
    startedAt: Date.now(),
    endedAt: null,
    mode: payload.mode || "scrollOnly",
    delayMs: Number(payload.delayMs || 800),
    maxShots: Number(payload.maxShots || 120),
    maxPages: Number(payload.maxPages || 1),
    exportText: !!payload.exportText,
    shots: [],
    errors: []
  };
}

function appendSessionError(sessionId, message) {
  const meta = sessions.get(sessionId);
  if (!meta) return;
  meta.errors.push({
    ts: Date.now(),
    message: String(message || "unknown error")
  });
}

async function finalizeSession(sessionId) {
  const meta = sessions.get(sessionId);
  if (!meta) return false;

  meta.endedAt = Date.now();
  const jsonText = JSON.stringify(meta, null, 2);
  const filename = `${meta.baseDir}/session.json`;
  await downloadText(jsonText, filename, "application/json;charset=utf-8");
  return true;
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  (async () => {
    const type = msg?.type;
    const sessionId = normalizeSessionId(msg?.sessionId);
    const payload = msg?.payload || {};

    try {
      if (!type) return;

      if (type === MSG.SESSION_INIT) {
        const tabUrl = payload.url || sender?.tab?.url || "";
        let host = "unknown_host";
        try {
          host = safeName(new URL(tabUrl).host || "unknown_host");
        } catch (_e) {
          host = "unknown_host";
        }
        const baseDir = `page_capture/${host}/${safeName(sessionId)}`;

        sessions.set(sessionId, createSessionMeta(sessionId, baseDir, host, tabUrl, payload));

        sendStatus(sessionId, `会话已就绪：${baseDir}`);
        sendMessage(MSG.SESSION_READY, sessionId, { baseDir });
        return;
      }

      if (type === MSG.CAPTURE_REQUEST) {
        const meta = sessions.get(sessionId);
        if (!meta) throw new Error("未找到会话: " + sessionId);

        const index = Number(payload.index || 0);
        const dataUrl = await captureVisible();

        const filename = `${meta.baseDir}/shots/shot_${pad(index)}.png`;
        await downloadDataUrl(dataUrl, filename);

        meta.shots.push({ index, filename: `shots/shot_${pad(index)}.png`, ts: Date.now() });
        sendStatus(sessionId, `已保存：${filename}`);
        sendMessage(MSG.CAPTURE_SAVED, sessionId, { index, filename });
        return;
      }

      if (type === MSG.EXPORT_TEXT) {
        const meta = sessions.get(sessionId);
        if (!meta) throw new Error("未找到会话: " + sessionId);

        const title = payload.title || meta.title || "未命名页面";
        const url = payload.url || meta.url || "";
        const text = payload.text || "";

        const md =
`# ${title}

URL: ${url}

CapturedAt: ${new Date().toISOString()}

---

${text}
`;

        const filename = `${meta.baseDir}/page.md`;
        await downloadText(md, filename, "text/markdown;charset=utf-8");

        sendStatus(sessionId, `已保存：${filename}`);
        sendMessage(MSG.EXPORT_SAVED, sessionId, { filename });
        return;
      }

      if (type === MSG.SESSION_FINISH) {
        const saved = await finalizeSession(sessionId);
        if (!saved) return;

        sendStatus(sessionId, "会话已完成，已保存 session.json");
        sessions.delete(sessionId);
        return;
      }

      // Pass-through for popup
      if (type === MSG.STATUS || type === MSG.ERROR) {
        if (type === MSG.ERROR) {
          appendSessionError(sessionId, payload.message || "未知错误");
        }
        sendMessage(type, sessionId, payload);
        return;
      }
    } catch (e) {
      sendError(sessionId, String(e?.stack || e));
    }
  })();

  return true;
});
