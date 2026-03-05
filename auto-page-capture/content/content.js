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
const DEFAULT_OCR_MODE = "balanced";
const MIN_DOM_TEXT_LEN = 200;
const MIN_DOM_QUALITY_SCORE = 160;
const MIN_OCR_ACCEPT_SCORE = 88;
const OCR_TIMEOUT_MS = 18000;
const SCROLL_OVERLAP_MIN = 96;
const SCROLL_OVERLAP_MAX = 240;
const SCROLL_OVERLAP_RATIO = 0.18;

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

function requestMessage(type, sessionId, payload = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error(`请求超时: ${type}`));
    }, timeoutMs);

    chrome.runtime.sendMessage(makeMessage(type, sessionId, payload), (resp) => {
      if (done) return;
      clearTimeout(timer);
      done = true;
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(String(err.message || err)));
        return;
      }
      resolve(resp || {});
    });
  });
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

function normalizePlainText(text) {
  return String(text || "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function textLength(text) {
  return normalizePlainText(text).length;
}

function evaluateTextQuality(text) {
  const normalized = normalizePlainText(text);
  const len = normalized.length;
  if (!len) {
    return {
      length: 0,
      score: 0,
      validRatio: 0
    };
  }

  const cjk = (normalized.match(/[\u4e00-\u9fff]/g) || []).length;
  const alphaNum = (normalized.match(/[A-Za-z0-9]/g) || []).length;
  const punctuation = (normalized.match(/[，。！？；：、“”‘’（）()【】《》〈〉,.!?;:'"、\-_/]/g) || []).length;
  const lines = normalized.split(/\n+/).filter(Boolean).length || 1;
  const repeatedRuns = (normalized.match(/(.)\1{5,}/g) || []).length;
  const longDigitRuns = (normalized.match(/\d{8,}/g) || []).length;
  const invalidChars = normalized.replace(/[\u4e00-\u9fffA-Za-z0-9\s，。！？；：、“”‘’（）()【】《》〈〉,.!?;:'"、\-_/]/g, "");
  const invalid = invalidChars.length;
  const validRatio = Math.min(1, (cjk + alphaNum + punctuation) / Math.max(1, len));

  let score = 0;
  score += len * 0.34;
  score += validRatio * 120;
  score += Math.min(lines, 20) * 2;
  score -= invalid * 1.25;
  score -= repeatedRuns * 14;
  score -= longDigitRuns * 6;

  return {
    length: len,
    score: Math.max(0, Math.round(score)),
    validRatio
  };
}

function shouldPreferCandidate(baseEval, candidateEval, opts = {}) {
  const minLength = Math.max(1, Number(opts.minLength || 24));
  if (!candidateEval || candidateEval.length < minLength) return false;
  if (!baseEval) return true;

  if (baseEval.length < 40) {
    return candidateEval.score >= Math.max(18, baseEval.score - 4);
  }

  const scoreLead = candidateEval.score - baseEval.score;
  if (scoreLead >= 10) return true;
  if (scoreLead >= -4 && candidateEval.length > baseEval.length * 1.45) return true;
  return false;
}

function normalizeDedupToken(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .trim();
}

function mergeDomAndOcrText(domText, ocrText) {
  const domLines = normalizePlainText(domText).split("\n").map((v) => v.trim()).filter(Boolean);
  const ocrLines = normalizePlainText(ocrText).split("\n").map((v) => v.trim()).filter(Boolean);
  if (!domLines.length) return normalizePlainText(ocrText);
  if (!ocrLines.length) return normalizePlainText(domText);

  const merged = [...domLines];
  const tokens = new Set(
    domLines
      .map((line) => normalizeDedupToken(line))
      .filter((token) => token.length >= 6)
  );

  let appended = 0;
  for (const line of ocrLines) {
    if (line.length < 8) continue;
    const token = normalizeDedupToken(line);
    if (token.length < 6) continue;
    if (tokens.has(token)) continue;
    merged.push(line);
    tokens.add(token);
    appended += 1;
    if (appended >= 120) break;
  }

  return normalizePlainText(merged.join("\n"));
}

function normalizeOcrLanguage(value) {
  const v = String(value || "").trim().toLowerCase();
  return v || "chs";
}

function normalizeOcrMode(value) {
  const v = String(value || "").trim().toLowerCase();
  if (v === "fast" || v === "accurate") return v;
  return DEFAULT_OCR_MODE;
}

function getOcrTimeoutByMode(mode) {
  const m = normalizeOcrMode(mode);
  if (m === "fast") return 9000;
  if (m === "accurate") return 26000;
  return OCR_TIMEOUT_MS;
}

function toNumber(value, fallback, min = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, n);
}

function calcScrollStep(viewport) {
  const vp = Math.max(1, Number(viewport || 0));
  const overlap = Math.min(
    SCROLL_OVERLAP_MAX,
    Math.max(SCROLL_OVERLAP_MIN, Math.round(vp * SCROLL_OVERLAP_RATIO))
  );
  return Math.max(80, vp - overlap);
}

function getElementText(el) {
  if (!el) return "";
  return normalizePlainText(el.innerText || el.textContent || "");
}

function calcLinkDensity(el) {
  if (!el) return 1;
  const allText = getElementText(el);
  if (!allText) return 1;
  const linkText = normalizePlainText(
    Array.from(el.querySelectorAll("a"))
      .map((a) => a.innerText || a.textContent || "")
      .join(" ")
  );
  return Math.min(1, textLength(linkText) / Math.max(1, textLength(allText)));
}

function scoreContentCandidate(el) {
  if (!el) return -Infinity;
  const text = getElementText(el);
  const len = textLength(text);
  if (len < 60) return -Infinity;

  const pCount = el.querySelectorAll("p").length;
  const headingCount = el.querySelectorAll("h1,h2,h3").length;
  const linkDensity = calcLinkDensity(el);
  const mediaCount = el.querySelectorAll("img,figure,video").length;

  let score = len;
  score += pCount * 120;
  score += headingCount * 80;
  score += mediaCount * 10;
  score -= linkDensity * 800;

  const idCls = `${el.id || ""} ${(el.className || "").toString()}`.toLowerCase();
  if (/(content|article|post|entry|main|markdown|reader)/.test(idCls)) score += 300;
  if (/(nav|menu|sidebar|footer|header|comment|advert|ads)/.test(idCls)) score -= 400;

  const tag = String(el.tagName || "").toLowerCase();
  if (tag === "main" || tag === "article") score += 250;
  if (tag === "nav" || tag === "aside" || tag === "footer") score -= 400;

  return score;
}

function extractDomPrimaryText() {
  const preferred = [
    "main",
    "article",
    "[role='main']",
    "#content",
    ".content",
    ".post-content",
    ".article-content",
    ".entry-content",
    ".markdown-body"
  ];

  const candidates = [];
  for (const sel of preferred) {
    const el = document.querySelector(sel);
    if (el) candidates.push(el);
  }
  candidates.push(...Array.from(document.querySelectorAll("section,article,main,div")));
  candidates.push(document.body);

  let best = null;
  let bestScore = -Infinity;
  for (const el of candidates) {
    const score = scoreContentCandidate(el);
    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  }

  const text = getElementText(best);
  return {
    text,
    source: best ? (best.tagName || "BODY").toLowerCase() : "body",
    score: bestScore
  };
}

function extractAccessibleImageText() {
  const parts = [];
  const push = (s) => {
    const t = normalizePlainText(s);
    if (t && t.length >= 2) parts.push(t);
  };

  Array.from(document.querySelectorAll("img")).forEach((img) => {
    push(img.alt);
    push(img.getAttribute("aria-label"));
    push(img.title);
  });
  Array.from(document.querySelectorAll("figure figcaption")).forEach((n) => push(n.innerText || n.textContent));
  Array.from(document.querySelectorAll("svg text")).forEach((n) => push(n.textContent));
  Array.from(document.querySelectorAll("[aria-label]")).slice(0, 120).forEach((n) => push(n.getAttribute("aria-label")));

  const uniq = Array.from(new Set(parts));
  return normalizePlainText(uniq.join("\n"));
}

async function requestOcrText(sessionId, options = {}) {
  const ocrMode = normalizeOcrMode(options.ocrMode);
  const timeoutMs = Number(options.ocrTimeoutMs || getOcrTimeoutByMode(ocrMode));
  const payload = {
    apiKey: String(options.ocrApiKey || "").trim(),
    mode: ocrMode,
    language: normalizeOcrLanguage(options.ocrLanguage),
    timeoutMs
  };

  try {
    const resp = await requestMessage(
      MSG.OCR_REQUEST,
      sessionId,
      payload,
      Number(timeoutMs || OCR_TIMEOUT_MS) + 3000
    );
    if (resp?.ok && textLength(resp.text) > 0) {
      return {
        ok: true,
        text: normalizePlainText(resp.text),
        provider: resp.provider || "ocrspace",
        variant: resp.variant || "original",
        score: Number(resp.score || 0),
        attempts: Array.isArray(resp.attempts) ? resp.attempts : []
      };
    }
    return {
      ok: false,
      error: String(resp?.error || "OCR_EMPTY"),
      attempts: Array.isArray(resp?.attempts) ? resp.attempts : []
    };
  } catch (e) {
    return {
      ok: false,
      error: String(e?.message || e || "OCR_REQUEST_FAILED")
    };
  }
}

async function getPageText(options = {}) {
  const minDomTextLength = Math.max(0, Number(options.minDomTextLength || MIN_DOM_TEXT_LEN));
  const minDomQualityScore = Math.max(0, Number(options.minDomQualityScore || MIN_DOM_QUALITY_SCORE));
  const allowFallback = options.allowFallback !== false;
  const ocrEnabled = !!options.ocrEnabled;

  const dom = extractDomPrimaryText();
  const domLen = textLength(dom.text);
  const domEval = evaluateTextQuality(dom.text);
  const needOcrByLength = domLen < minDomTextLength;
  const needOcrByQuality = domEval.score < minDomQualityScore;
  const shouldTryOcr = allowFallback && (needOcrByLength || needOcrByQuality);

  let finalText = dom.text;
  let finalEval = domEval;
  let source = "dom";
  let reason = "dom_primary";
  let ocrProvider = "";
  let ocrError = "";
  let ocrVariant = "";
  let ocrScore = 0;

  if (shouldTryOcr) {
    if (ocrEnabled) {
      const ocr = await requestOcrText(currentSessionId, options);
      if (ocr.ok) {
        const ocrEval = evaluateTextQuality(ocr.text);
        ocrProvider = ocr.provider || "ocrspace";
        ocrVariant = ocr.variant || "original";
        ocrScore = Number(ocr.score || ocrEval.score || 0);
        if (ocrEval.score >= MIN_OCR_ACCEPT_SCORE && shouldPreferCandidate(domEval, ocrEval, { minLength: 30 })) {
          finalText = ocr.text;
          finalEval = ocrEval;
          source = "ocr_engine";
          reason = needOcrByLength ? "dom_too_short_use_remote_ocr" : "dom_quality_low_use_remote_ocr";
        } else if (ocrEval.score >= MIN_OCR_ACCEPT_SCORE) {
          const mergedText = mergeDomAndOcrText(dom.text, ocr.text);
          const mergedEval = evaluateTextQuality(mergedText);
          if (
            shouldPreferCandidate(domEval, mergedEval, { minLength: 40 }) &&
            mergedEval.score >= domEval.score + 6 &&
            mergedEval.length >= domEval.length + 20
          ) {
            finalText = mergedText;
            finalEval = mergedEval;
            source = "hybrid_dom_ocr";
            reason = "dom_ocr_merge";
          } else {
            ocrError = `OCR_NOT_BETTER(dom=${domEval.score},ocr=${ocrEval.score},merged=${mergedEval.score})`;
          }
        } else {
          ocrError = `OCR_QUALITY_LOW(dom=${domEval.score},ocr=${ocrEval.score},min=${MIN_OCR_ACCEPT_SCORE})`;
        }
      } else {
        ocrError = String(ocr.error || "OCR_FAILED");
      }
    }

    if (source === "dom" && needOcrByLength) {
      const fallbackText = extractAccessibleImageText();
      const fallbackEval = evaluateTextQuality(fallbackText);
      if (shouldPreferCandidate(domEval, fallbackEval, { minLength: 20 })) {
        finalText = fallbackText;
        finalEval = fallbackEval;
        source = "ocr_fallback_accessible";
        reason = ocrEnabled
          ? "dom_too_short_ocr_failed_use_accessible_image_text"
          : "dom_too_short_use_accessible_image_text";
      } else if (ocrEnabled && ocrError) {
        reason = "dom_too_short_ocr_not_better_keep_dom";
      } else {
        reason = "dom_too_short_keep_dom";
      }
    } else if (source === "dom" && needOcrByQuality) {
      reason = ocrEnabled && ocrError ? "dom_quality_low_ocr_not_better_keep_dom" : "dom_quality_low_keep_dom";
    }
  }

  return {
    title: document.title || "",
    url: location.href,
    text: finalText,
    extractMeta: {
      source,
      reason,
      ocrEnabled,
      ocrMode: normalizeOcrMode(options.ocrMode),
      ocrProvider,
      ocrError,
      ocrVariant,
      ocrScore,
      domSource: dom.source,
      domScore: dom.score,
      domLength: domLen,
      domQuality: domEval.score,
      finalLength: textLength(finalText),
      finalQuality: finalEval.score,
      minDomTextLength,
      minDomQualityScore
    }
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
  pushStatus("已启用重叠滚动策略，优化中间衔接与内容完整性。");

  let index = 0;
  let unchangedScrollCount = 0;

  while (shouldContinue(runId) && index < maxShots) {
    const beforeCapture = getPageMetrics();
    const shotIndex = index;

    if (!shouldContinue(runId)) break;
    sendMessage(MSG.CAPTURE_REQUEST, currentSessionId, {
      index: shotIndex,
      y: beforeCapture.y,
      viewport: beforeCapture.viewport,
      scrollHeight: beforeCapture.scrollHeight
    });
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

    const step = calcScrollStep(afterCapture.viewport);
    const targetY = afterCapture.y + step;
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
    exportText: !!config.exportText,
    exportPdf: config.exportPdf !== false,
    pdfSinglePage: config.pdfSinglePage !== false,
    ocrEnabled: !!config.ocrEnabled,
    ocrMode: normalizeOcrMode(config.ocrMode),
    ocrLanguage: normalizeOcrLanguage(config.ocrLanguage)
  });

  if (!(await interruptibleSleep(200, runId))) {
    setState(STATE.FINISHED);
    sendMessage(MSG.SESSION_FINISH, currentSessionId, {});
    pushStatus(`状态=${state}；在截图开始前已停止。`);
    return;
  }

  if (config.exportText && shouldContinue(runId)) {
    const pageText = await getPageText({
      minDomTextLength: MIN_DOM_TEXT_LEN,
      minDomQualityScore: MIN_DOM_QUALITY_SCORE,
      allowFallback: true,
      ocrEnabled: !!config.ocrEnabled,
      ocrMode: normalizeOcrMode(config.ocrMode),
      ocrLanguage: normalizeOcrLanguage(config.ocrLanguage),
      ocrApiKey: String(config.ocrApiKey || "").trim(),
      ocrTimeoutMs: getOcrTimeoutByMode(config.ocrMode)
    });
    if (pageText.extractMeta?.source === "ocr_engine") {
      pushStatus(`DOM 文本较少，已使用 OCR 引擎兜底（模式=${pageText.extractMeta?.ocrMode || DEFAULT_OCR_MODE}）。`);
    } else if (pageText.extractMeta?.source === "hybrid_dom_ocr") {
      pushStatus(`DOM 与 OCR 已融合，补齐漏识别内容（模式=${pageText.extractMeta?.ocrMode || DEFAULT_OCR_MODE}）。`);
    } else if (pageText.extractMeta?.source === "ocr_fallback_accessible") {
      pushStatus("DOM 文本较少，已启用 OCR 兜底（图像可访问文本策略）。");
    } else if (pageText.extractMeta?.reason === "dom_too_short_ocr_not_better_keep_dom") {
      pushStatus("DOM 文本较少，但 OCR 质量不足，已保留 DOM 文本。");
    } else if (pageText.extractMeta?.reason === "dom_quality_low_ocr_not_better_keep_dom") {
      pushStatus("DOM 文本质量偏低，但 OCR 未带来明显提升，已保留 DOM 文本。");
    } else {
      pushStatus("文本导出使用 DOM 主内容提取。");
    }
    sendMessage(MSG.EXPORT_TEXT, currentSessionId, pageText);
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
    const payload = msg.payload || {};
    const config = {
      sessionId,
      mode: payload.mode === "nextPage" ? "nextPage" : "scrollOnly",
      delayMs: toNumber(payload.delayMs, 800, 100),
      maxShots: toNumber(payload.maxShots, 120, 1),
      maxPages: toNumber(payload.maxPages, 1, 1),
      exportText: payload.exportText !== false,
      exportPdf: payload.exportPdf !== false,
      pdfSinglePage: payload.pdfSinglePage !== false,
      ocrEnabled: !!payload.ocrEnabled,
      ocrMode: normalizeOcrMode(payload.ocrMode),
      ocrLanguage: normalizeOcrLanguage(payload.ocrLanguage),
      ocrApiKey: String(payload.ocrApiKey || "").trim()
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
