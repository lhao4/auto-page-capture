const MSG = window.APC.MSG;
const sleep = window.APC.sleep;
const UNKNOWN_SESSION_ID = "无";
const STATE = {
  IDLE: "IDLE",
  RUNNING: "RUNNING",
  STOPPING: "STOPPING",
  FINISHED: "FINISHED"
};
const STOP_POLL_MS = 50;
const STABLE_POLL_MS = 120;
const STABLE_REQUIRED_ROUNDS = 3;
const STABLE_MAX_WAIT_MS = 2000;
const NAV_POLL_MS = 100;
const NAV_TIMEOUT_MS = 8000;

let state = STATE.IDLE;
let currentSessionId = UNKNOWN_SESSION_ID;
let activeRunId = 0;

function normalizeSessionId(sessionId) {
  return sessionId ? String(sessionId) : UNKNOWN_SESSION_ID;
}

function setState(nextState) {
  state = nextState;
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

function pushStatus(text) {
  sendMessage(MSG.STATUS, currentSessionId, { text });
}

function pushError(message, sessionId = currentSessionId) {
  sendMessage(MSG.ERROR, sessionId, { message });
}

function canStartNewRun() {
  return state === STATE.IDLE || state === STATE.FINISHED;
}

function shouldContinue(runId) {
  return state === STATE.RUNNING && runId === activeRunId;
}

async function interruptibleSleep(ms, runId) {
  const end = Date.now() + Number(ms || 0);
  while (Date.now() < end) {
    if (!shouldContinue(runId)) return false;
    await sleep(Math.min(STOP_POLL_MS, end - Date.now()));
  }
  return shouldContinue(runId);
}

function getPageText() {
  return {
    title: document.title || "",
    url: location.href,
    text: document.body?.innerText || ""
  };
}

function getPageMetrics() {
  const doc = document.documentElement;
  const body = document.body;
  return {
    y: window.scrollY,
    viewport: window.innerHeight,
    scrollHeight: Math.max(doc?.scrollHeight || 0, body?.scrollHeight || 0),
    pendingImages: Array.from(document.images || []).filter((img) => !img.complete).length
  };
}

async function waitForContentStable(runId, timeoutMs = STABLE_MAX_WAIT_MS) {
  const deadline = Date.now() + Number(timeoutMs || STABLE_MAX_WAIT_MS);
  let stableRounds = 0;
  let prev = getPageMetrics();

  while (Date.now() < deadline) {
    if (!shouldContinue(runId)) return false;
    await sleep(STABLE_POLL_MS);

    const current = getPageMetrics();
    const sameHeight = current.scrollHeight === prev.scrollHeight;
    const samePendingImages = current.pendingImages === prev.pendingImages;

    if (sameHeight && (current.pendingImages === 0 || samePendingImages)) {
      stableRounds += 1;
      if (stableRounds >= STABLE_REQUIRED_ROUNDS) return true;
    } else {
      stableRounds = 0;
    }

    prev = current;
  }

  return shouldContinue(runId);
}

function findNextPageElement() {
  const relNext = document.querySelector('a[rel="next"]');
  if (relNext) return relNext;

  const aria = document.querySelector(
    'a[aria-label*="Next"],button[aria-label*="Next"],a[aria-label*="下一页"],button[aria-label*="下一页"]'
  );
  if (aria) return aria;

  const candidates = Array.from(document.querySelectorAll("a,button"));
  const hit = candidates.find((el) => {
    const t = (el.innerText || "").replace(/\s+/g, "").toLowerCase();
    return (
      t === "next" ||
      t === "next>" ||
      t.includes("nextpage") ||
      t.includes("下一页") ||
      t.includes("下页") ||
      t === "›" ||
      t === "»"
    );
  });
  if (hit) return hit;

  const fallback = document.querySelector("a.next,button.next,.pagination-next a,.pagination-next button,#next");
  return fallback || null;
}

function getDomFingerprint() {
  const main = document.querySelector("main,[role='main'],article,#content,.content") || document.body;
  const title = document.title || "";
  const marker = main?.querySelector("h1,h2,.title,[data-title]")?.textContent || "";
  const childCount = main?.childElementCount || 0;
  const textLen = (main?.innerText || "").replace(/\s+/g, " ").trim().length;
  return `${title}|${marker.slice(0, 80)}|${childCount}|${textLen}`;
}

async function waitForNavigationOrDomChange(oldUrl, oldFingerprint, runId, timeoutMs = NAV_TIMEOUT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!shouldContinue(runId)) return { ok: false, reason: "stopped" };

    const newUrl = location.href;
    if (newUrl !== oldUrl) {
      return { ok: true, reason: "url_changed" };
    }

    const newFingerprint = getDomFingerprint();
    if (newFingerprint !== oldFingerprint) {
      return { ok: true, reason: "dom_changed" };
    }

    await sleep(NAV_POLL_MS);
  }

  return { ok: false, reason: "timeout" };
}

async function runCaptureLoop(config, runId) {
  const { delayMs, maxShots } = config;

  if (!shouldContinue(runId)) return 0;
  window.scrollTo(0, 0);
  if (!(await interruptibleSleep(delayMs, runId))) return 0;
  if (!(await waitForContentStable(runId))) return 0;

  let index = 0;
  let unchangedScrollCount = 0;

  while (shouldContinue(runId) && index < maxShots) {
    const beforeCapture = getPageMetrics();
    const shotIndex = index;

    if (!shouldContinue(runId)) break;
    sendMessage(MSG.CAPTURE_REQUEST, currentSessionId, { index: shotIndex });
    index += 1;

    pushStatus(
      `正在截图 #${shotIndex}（Y=${beforeCapture.y} / H=${beforeCapture.scrollHeight}，待加载图片=${beforeCapture.pendingImages}）`
    );

    if (index >= maxShots) {
      pushStatus(`达到最大截图数 maxShots=${maxShots}，停止截图循环。`);
      break;
    }

    if (!(await interruptibleSleep(delayMs, runId))) break;
    if (!(await waitForContentStable(runId))) break;

    const afterCapture = getPageMetrics();
    const isAtBottom = afterCapture.y + afterCapture.viewport + 2 >= afterCapture.scrollHeight;
    if (isAtBottom) {
      pushStatus(`在截图 #${shotIndex} 时到达页面底部。`);
      break;
    }

    const targetY = afterCapture.y + afterCapture.viewport;
    if (!shouldContinue(runId)) break;
    window.scrollTo(0, targetY);
    if (!(await interruptibleSleep(delayMs, runId))) break;
    if (!(await waitForContentStable(runId))) break;

    const afterScroll = getPageMetrics();
    const moved = afterScroll.y > afterCapture.y + 1;
    if (!moved) {
      unchangedScrollCount += 1;
      pushStatus(`滚动位置未变化（${unchangedScrollCount}/3）。`);
      if (unchangedScrollCount >= 3) {
        pushStatus("触发防死循环：滚动位置连续 3 次未变化，停止。");
        break;
      }
    } else {
      unchangedScrollCount = 0;
    }

  }

  return index;
}

async function run(config) {
  if (!canStartNewRun()) {
    pushStatus(`忽略开始请求：当前状态为 ${state}`);
    return;
  }

  activeRunId += 1;
  const runId = activeRunId;
  setState(STATE.RUNNING);

  currentSessionId = normalizeSessionId(config.sessionId || window.APC.nowSessionId());
  pushStatus(`状态=${state}；正在初始化会话...`);

  sendMessage(MSG.SESSION_INIT, currentSessionId, {
    url: location.href,
    title: document.title || "",
    mode: config.mode,
    delayMs: config.delayMs,
    maxShots: config.maxShots,
    maxPages: config.maxPages,
    exportText: !!config.exportText
  });

  if (!(await interruptibleSleep(200, runId))) {
    setState(STATE.FINISHED);
    sendMessage(MSG.SESSION_FINISH, currentSessionId, {});
    pushStatus(`状态=${state}；在截图开始前已停止。`);
    return;
  }

  if (config.exportText && shouldContinue(runId)) {
    sendMessage(MSG.EXPORT_TEXT, currentSessionId, getPageText());
  }

  const totalPages = Math.max(1, Number(config.maxPages || 1));
  const maxPageTurns = Math.max(0, totalPages - 1);
  let pageTurnsDone = 0;

  while (shouldContinue(runId)) {
    pushStatus(`正在抓取第 ${pageTurnsDone + 1} / ${totalPages} 页`);
    await runCaptureLoop(config, runId);

    if (!shouldContinue(runId)) break;
    if (config.mode !== "nextPage") break;
    if (pageTurnsDone >= maxPageTurns) {
      pushStatus(`达到最大页数 maxPages=${totalPages}，准备结束。`);
      break;
    }

    const nextEl = findNextPageElement();
    if (!nextEl) {
      pushStatus("[NEXT_PAGE_NOT_FOUND] 已到底部或未找到下一页控件，准备结束。");
      break;
    }

    const oldUrl = location.href;
    const oldFingerprint = getDomFingerprint();
    pushStatus("正在点击下一页...");
    nextEl.click();

    const nav = await waitForNavigationOrDomChange(oldUrl, oldFingerprint, runId, NAV_TIMEOUT_MS);
    if (!(await interruptibleSleep(config.delayMs, runId))) break;
    if (!(await waitForContentStable(runId))) break;

    if (!nav.ok) {
      if (!shouldContinue(runId)) break;
      if (nav.reason === "timeout") {
        pushStatus("[NAV_TIMEOUT] 点击下一页后 URL/DOM 在超时内未变化，准备结束。");
      } else {
        pushStatus("翻页流程被中断，准备结束。");
      }
      break;
    }

    if (nav.reason === "dom_changed") {
      pushStatus("URL 未变化，但检测到 DOM 已变化，判定翻页成功。");
    }

    pageTurnsDone += 1;

    if (!shouldContinue(runId)) break;
    window.scrollTo(0, 0);
    if (!(await interruptibleSleep(config.delayMs, runId))) break;
    if (!(await waitForContentStable(runId))) break;
  }

  setState(STATE.FINISHED);
  sendMessage(MSG.SESSION_FINISH, currentSessionId, {});
  pushStatus(`状态=${state}；已完成。`);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg?.type) return;

  if (msg.type === MSG.START_CAPTURE) {
    const sessionId = normalizeSessionId(msg.sessionId || window.APC.nowSessionId());
    const config = {
      ...(msg.payload || {}),
      sessionId
    };
    run(config).catch((e) => {
      setState(STATE.FINISHED);
      pushError(String(e?.stack || e), sessionId);
    });
  }

  if (msg.type === MSG.STOP_CAPTURE) {
    const nextSessionId = normalizeSessionId(msg.sessionId || currentSessionId);
    currentSessionId = nextSessionId;
    if (state === STATE.RUNNING) {
      setState(STATE.STOPPING);
      pushStatus(`状态=${state}；正在停止...`);
      return;
    }
    pushStatus(`忽略停止请求：当前状态为 ${state}`);
  }
});
