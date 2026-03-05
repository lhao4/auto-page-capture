// background/service_worker.js (MV3)
// NOTE: service worker has no DOM/window.

const UNKNOWN_SESSION_ID = "无";
const MSG = {
  SESSION_INIT: "SESSION_INIT",
  SESSION_READY: "SESSION_READY",
  CAPTURE_REQUEST: "CAPTURE_REQUEST",
  CAPTURE_SAVED: "CAPTURE_SAVED",
  OCR_REQUEST: "OCR_REQUEST",
  EXPORT_TEXT: "EXPORT_TEXT",
  EXPORT_SAVED: "EXPORT_SAVED",
  STATUS: "STATUS",
  ERROR: "ERROR",
  SESSION_FINISH: "SESSION_FINISH"
};
const OCR_PROVIDER = "ocrspace";
const DEFAULT_OCR_MODE = "balanced";
const OCR_MAX_DIM = 4200;
const PDF_MAX_WIDTH_PX = 2600;
const PDF_JPEG_QUALITY = 0.97;
const PDF_PX_TO_PT = 0.75;
const PDF_SINGLE_PAGE_MAX_HEIGHT_PX = 28000;
const PDF_SINGLE_PAGE_MAX_AREA = 95_000_000;
const PDF_LOSSLESS_PREFERRED = true;
const PDF_LOSSLESS_MAX_AREA = 36_000_000;

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

function encodeUtf8(text) {
  return new TextEncoder().encode(String(text || ""));
}

function concatBytes(parts) {
  let total = 0;
  for (const part of parts) total += part.length;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }
  return merged;
}

function toPdfNumber(value) {
  if (!Number.isFinite(Number(value))) return "0";
  return Number(Number(value).toFixed(2)).toString();
}

function rgbaToRgbBytes(rgba) {
  const rgb = new Uint8Array(Math.floor(rgba.length / 4) * 3);
  let j = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    rgb[j++] = rgba[i];
    rgb[j++] = rgba[i + 1];
    rgb[j++] = rgba[i + 2];
  }
  return rgb;
}

async function deflateBytes(bytes) {
  if (typeof CompressionStream === "undefined") return null;
  const cs = new CompressionStream("deflate");
  const writer = cs.writable.getWriter();
  await writer.write(bytes);
  await writer.close();
  const compressed = new Uint8Array(await new Response(cs.readable).arrayBuffer());
  return compressed;
}

async function canvasToPdfImagePage(canvas, options = {}) {
  const width = canvas.width;
  const height = canvas.height;
  const area = width * height;
  const preferLossless = options.preferLossless !== false;
  const quality = Math.min(0.98, Math.max(0.65, Number(options.quality || PDF_JPEG_QUALITY)));

  if (preferLossless && area <= PDF_LOSSLESS_MAX_AREA) {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (ctx) {
      try {
        const imageData = ctx.getImageData(0, 0, width, height);
        const rgb = rgbaToRgbBytes(imageData.data);
        const deflated = await deflateBytes(rgb);
        if (deflated && deflated.length > 0) {
          return {
            width,
            height,
            imageBytes: deflated,
            filter: "FlateDecode"
          };
        }
      } catch (_e) {
        // ignore and fallback jpeg
      }
    }
  }

  const jpegBlob = await canvas.convertToBlob({ type: "image/jpeg", quality });
  const jpegBytes = new Uint8Array(await jpegBlob.arrayBuffer());
  return {
    width,
    height,
    imageBytes: jpegBytes,
    filter: "DCTDecode"
  };
}

async function dataUrlToJpegPage(dataUrl, options = {}) {
  if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap !== "function") {
    throw new Error("当前运行环境不支持 PDF 渲染所需的 OffscreenCanvas/createImageBitmap");
  }

  const maxWidth = Math.max(320, Number(options.maxWidth || PDF_MAX_WIDTH_PX));
  const quality = Math.min(0.98, Math.max(0.65, Number(options.quality || PDF_JPEG_QUALITY)));
  const blob = await fetch(dataUrl).then((r) => r.blob());
  const bitmap = await createImageBitmap(blob);

  try {
    const scale = Math.min(1, maxWidth / Math.max(1, bitmap.width));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("创建 PDF 画布失败");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, width, height);
    return await canvasToPdfImagePage(canvas, {
      quality,
      preferLossless: options.preferLossless !== false
    });
  } finally {
    try {
      bitmap?.close?.();
    } catch (_e) {
      // ignore
    }
  }
}

function calcTopCropByScrollMeta(prevPage, currPage) {
  const prevY = Number(prevPage?.meta?.y);
  const currY = Number(currPage?.meta?.y);
  const prevViewport = Number(prevPage?.meta?.viewport);
  if (!Number.isFinite(prevY) || !Number.isFinite(currY)) return 0;
  if (!Number.isFinite(prevViewport) || prevViewport <= 1) return 0;

  const deltaCss = currY - prevY;
  if (!Number.isFinite(deltaCss) || deltaCss <= 0) return 0;

  const pxPerCss = prevPage.height / prevViewport;
  const shiftPx = Math.round(deltaCss * pxPerCss);
  if (!Number.isFinite(shiftPx) || shiftPx <= 0) return 0;

  const overlapPx = prevPage.height - shiftPx;
  if (!Number.isFinite(overlapPx) || overlapPx <= 0) return 0;

  const maxSafeCrop = Math.floor(currPage.height * 0.45);
  return Math.max(0, Math.min(maxSafeCrop, overlapPx));
}

function canUseSinglePageCanvas(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
  if (width < 1 || height < 1) return false;
  if (height > PDF_SINGLE_PAGE_MAX_HEIGHT_PX) return false;
  if (width * height > PDF_SINGLE_PAGE_MAX_AREA) return false;
  return true;
}

async function composeSinglePageJpegFromFrames(frames = [], options = {}) {
  if (!Array.isArray(frames) || frames.length === 0) {
    return { ok: false, reason: "no_frames" };
  }
  if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap !== "function") {
    return { ok: false, reason: "canvas_unsupported" };
  }

  const maxWidth = Math.max(320, Number(options.maxWidth || PDF_MAX_WIDTH_PX));
  const quality = Math.min(0.98, Math.max(0.65, Number(options.quality || PDF_JPEG_QUALITY)));
  const loaded = [];
  let totalHeight = 0;
  let canvasWidth = 0;

  try {
    for (const frame of frames) {
      const blob = await fetch(frame.dataUrl).then((r) => r.blob());
      const bitmap = await createImageBitmap(blob);
      const scale = Math.min(1, maxWidth / Math.max(1, bitmap.width));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));

      loaded.push({
        bitmap,
        width,
        height,
        meta: frame.meta || {}
      });
    }

    if (!loaded.length) {
      return { ok: false, reason: "no_frames_loaded" };
    }

    const crops = loaded.map(() => 0);
    for (let i = 1; i < loaded.length; i += 1) {
      crops[i] = calcTopCropByScrollMeta(loaded[i - 1], loaded[i]);
    }

    for (let i = 0; i < loaded.length; i += 1) {
      const item = loaded[i];
      const drawHeight = Math.max(1, item.height - crops[i]);
      canvasWidth = Math.max(canvasWidth, item.width);
      totalHeight += drawHeight;

      if (!canUseSinglePageCanvas(canvasWidth, totalHeight)) {
        return {
          ok: false,
          reason: "too_tall",
          width: canvasWidth,
          height: totalHeight
        };
      }
    }

    if (!canUseSinglePageCanvas(canvasWidth, totalHeight)) {
      return {
        ok: false,
        reason: "too_tall",
        width: canvasWidth,
        height: totalHeight
      };
    }

    const canvas = new OffscreenCanvas(canvasWidth, totalHeight);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return { ok: false, reason: "ctx_failed" };
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvasWidth, totalHeight);

    let y = 0;
    for (let i = 0; i < loaded.length; i += 1) {
      const item = loaded[i];
      const cropTop = crops[i];
      const drawHeight = Math.max(1, item.height - cropTop);
      ctx.drawImage(
        item.bitmap,
        0,
        cropTop,
        item.width,
        drawHeight,
        0,
        y,
        item.width,
        drawHeight
      );
      y += drawHeight;
    }

    const page = await canvasToPdfImagePage(canvas, {
      quality,
      preferLossless: options.preferLossless !== false
    });
    return {
      ok: true,
      page
    };
  } catch (_e) {
    return { ok: false, reason: "compose_failed" };
  } finally {
    for (const item of loaded) {
      try {
        item.bitmap?.close?.();
      } catch (_e) {
        // ignore
      }
    }
  }
}

async function buildPagedPdfPages(frames = []) {
  const pages = [];
  for (const frame of frames) {
    const page = await dataUrlToJpegPage(frame.dataUrl, {
      maxWidth: PDF_MAX_WIDTH_PX,
      quality: PDF_JPEG_QUALITY,
      preferLossless: PDF_LOSSLESS_PREFERRED
    });
    pages.push(page);
  }
  return pages;
}

function buildPdfFromJpegPages(pages = []) {
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error("PDF 构建失败：没有可用页面");
  }

  const totalObjects = 2 + pages.length * 3;
  const offsets = new Array(totalObjects + 1).fill(0);
  const chunks = [];
  let fileLength = 0;

  const pushBytes = (bytes) => {
    chunks.push(bytes);
    fileLength += bytes.length;
  };
  const pushText = (text) => {
    pushBytes(encodeUtf8(text));
  };
  const writeObj = (objNum, parts) => {
    offsets[objNum] = fileLength;
    pushText(`${objNum} 0 obj\n`);
    for (const part of parts) {
      if (typeof part === "string") {
        pushText(part);
      } else {
        pushBytes(part);
      }
    }
    pushText("\nendobj\n");
  };

  pushText("%PDF-1.4\n%APC\n");

  const kids = pages
    .map((_, i) => `${3 + i * 3} 0 R`)
    .join(" ");

  writeObj(1, [`<< /Type /Catalog /Pages 2 0 R >>`]);
  writeObj(2, [`<< /Type /Pages /Count ${pages.length} /Kids [${kids}] >>`]);

  for (let i = 0; i < pages.length; i += 1) {
    const pageObj = 3 + i * 3;
    const contentObj = pageObj + 1;
    const imageObj = pageObj + 2;
    const page = pages[i];
    const imageName = `Im${i + 1}`;
    const imageBytes = page.imageBytes || page.jpegBytes || new Uint8Array();
    const imageFilter = String(page.filter || "DCTDecode");

    const pageW = toPdfNumber(page.width * PDF_PX_TO_PT);
    const pageH = toPdfNumber(page.height * PDF_PX_TO_PT);
    const contentText =
      `q\n` +
      `${pageW} 0 0 ${pageH} 0 0 cm\n` +
      `/${imageName} Do\n` +
      `Q\n`;
    const contentBytes = encodeUtf8(contentText);

    writeObj(pageObj, [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] `,
      `/Resources << /XObject << /${imageName} ${imageObj} 0 R >> >> `,
      `/Contents ${contentObj} 0 R >>`
    ]);

    writeObj(contentObj, [
      `<< /Length ${contentBytes.length} >>\nstream\n`,
      contentBytes,
      `\nendstream`
    ]);

    writeObj(imageObj, [
      `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} `,
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /${imageFilter} /Length ${imageBytes.length} >>\n`,
      `stream\n`,
      imageBytes,
      `\nendstream`
    ]);
  }

  const xrefOffset = fileLength;
  pushText(`xref\n0 ${totalObjects + 1}\n`);
  pushText("0000000000 65535 f \n");
  for (let i = 1; i <= totalObjects; i += 1) {
    pushText(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
  }
  pushText(`trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R >>\n`);
  pushText(`startxref\n${xrefOffset}\n%%EOF`);

  return concatBytes(chunks);
}

async function exportSessionPdf(meta) {
  if (!meta?.exportPdf) return false;
  const frames = Array.isArray(meta._pdfFrames) ? meta._pdfFrames.slice() : [];
  if (!frames.length) {
    sendStatus(meta.sessionId, "[PDF_SKIPPED] 本次无截图，未导出 long_capture.pdf");
    return false;
  }

  const sortedFrames = frames
    .filter((item) => item && Number.isFinite(Number(item.index)))
    .sort((a, b) => Number(a.index) - Number(b.index));

  sendStatus(meta.sessionId, `正在生成 PDF：共 ${sortedFrames.length} 张截图...`);
  let pdfPages = [];
  let layout = "multi";

  if (meta.pdfSinglePage !== false) {
    const single = await composeSinglePageJpegFromFrames(sortedFrames, {
      maxWidth: PDF_MAX_WIDTH_PX,
      quality: PDF_JPEG_QUALITY,
      preferLossless: PDF_LOSSLESS_PREFERRED
    });
    if (single.ok && single.page) {
      pdfPages = [single.page];
      layout = "single";
      sendStatus(meta.sessionId, "单页长 PDF 合成成功。");
    } else {
      const reason = single.reason || "unknown";
      sendStatus(meta.sessionId, `[PDF_SINGLE_PAGE_FALLBACK] 单页合成失败(${reason})，将自动导出多页 PDF。`);
    }
  }

  if (!pdfPages.length) {
    pdfPages = await buildPagedPdfPages(sortedFrames);
    layout = "multi";
  }

  const pdfBytes = buildPdfFromJpegPages(pdfPages);
  const base64 = bytesToBase64(pdfBytes);
  const filename = `${meta.baseDir}/long_capture.pdf`;
  await chrome.downloads.download({
    url: `data:application/pdf;base64,${base64}`,
    filename,
    saveAs: false
  });

  meta.pdf = {
    filename: "long_capture.pdf",
    pages: pdfPages.length,
    layout,
    ts: Date.now()
  };
  meta._pdfFrames = [];
  sendStatus(meta.sessionId, `已保存：${filename}`);
  return true;
}

function normalizeSessionId(sessionId) {
  return sessionId ? String(sessionId) : UNKNOWN_SESSION_ID;
}

function normalizeOcrMode(value) {
  const v = String(value || "").trim().toLowerCase();
  if (v === "fast" || v === "accurate") return v;
  return DEFAULT_OCR_MODE;
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

function sendStatus(sessionId, text, extraPayload = {}) {
  sendMessage(MSG.STATUS, sessionId, {
    text,
    ...(extraPayload || {})
  });
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
    exportPdf: payload.exportPdf !== false,
    pdfSinglePage: payload.pdfSinglePage !== false,
    ocrEnabled: !!payload.ocrEnabled,
    ocrMode: normalizeOcrMode(payload.ocrMode),
    ocrLanguage: String(payload.ocrLanguage || "chs"),
    pdf: null,
    _pdfFrames: [],
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

  if (meta.exportPdf) {
    try {
      await exportSessionPdf(meta);
    } catch (e) {
      const message = String(e?.message || e || "PDF_EXPORT_FAILED");
      appendSessionError(sessionId, `PDF_EXPORT_FAILED: ${message}`);
      sendStatus(sessionId, `[PDF_EXPORT_FAILED] ${message}`);
    }
  }

  meta.endedAt = Date.now();
  delete meta._pdfFrames;
  return true;
}

function parseOcrSpaceText(json) {
  const list = Array.isArray(json?.ParsedResults) ? json.ParsedResults : [];
  const text = list.map((item) => String(item?.ParsedText || "")).join("\n");
  return String(text || "").trim();
}

function scoreOcrText(text) {
  const normalized = String(text || "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const len = normalized.length;
  if (!len) return 0;

  const cjk = (normalized.match(/[\u4e00-\u9fff]/g) || []).length;
  const alphaNum = (normalized.match(/[A-Za-z0-9]/g) || []).length;
  const punctuation = (normalized.match(/[，。！？；：、“”‘’（）()【】《》〈〉,.!?;:'"、\-_/]/g) || []).length;
  const lines = normalized.split(/\n+/).filter(Boolean).length || 1;
  const repeatedRuns = (normalized.match(/(.)\1{5,}/g) || []).length;
  const invalidChars = normalized.replace(/[\u4e00-\u9fffA-Za-z0-9\s，。！？；：、“”‘’（）()【】《》〈〉,.!?;:'"、\-_/]/g, "");
  const invalid = invalidChars.length;
  const validRatio = Math.min(1, (cjk + alphaNum + punctuation) / Math.max(1, len));

  let score = 0;
  score += len * 0.35;
  score += validRatio * 125;
  score += Math.min(lines, 24) * 2;
  score -= repeatedRuns * 12;
  score -= invalid * 1.25;

  return Math.max(0, Math.round(score));
}

function cleanOcrText(text) {
  return String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b-\u200f\u202a-\u202e]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function clampColor(v) {
  if (v < 0) return 0;
  if (v > 255) return 255;
  return v;
}

function normalizeScale(width, height, preferredScale = 1) {
  let scale = Math.max(0.35, Number(preferredScale || 1));
  const maxSideAfterScale = Math.max(width, height) * scale;
  if (maxSideAfterScale > OCR_MAX_DIM) {
    scale = scale * (OCR_MAX_DIM / maxSideAfterScale);
  }
  return Math.max(0.35, scale);
}

async function dataUrlToImageBitmap(dataUrl) {
  const blob = await fetch(dataUrl).then((r) => r.blob());
  return await createImageBitmap(blob);
}

function applyImageFilter(pixelData, opts = {}) {
  const contrast = Number(opts.contrast || 1);
  const brightness = Number(opts.brightness || 0);
  const threshold = typeof opts.threshold === "number" ? Number(opts.threshold) : null;
  const grayscale = !!opts.grayscale;
  const invert = !!opts.invert;

  const data = pixelData.data;
  for (let i = 0; i < data.length; i += 4) {
    let r = data[i];
    let g = data[i + 1];
    let b = data[i + 2];

    if (grayscale) {
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = lum;
      g = lum;
      b = lum;
    }

    r = (r - 128) * contrast + 128 + brightness;
    g = (g - 128) * contrast + 128 + brightness;
    b = (b - 128) * contrast + 128 + brightness;

    if (threshold !== null) {
      const avg = (r + g + b) / 3;
      const v = avg >= threshold ? 255 : 0;
      r = v;
      g = v;
      b = v;
    }

    if (invert) {
      r = 255 - r;
      g = 255 - g;
      b = 255 - b;
    }

    data[i] = clampColor(r);
    data[i + 1] = clampColor(g);
    data[i + 2] = clampColor(b);
  }
}

async function estimateImageLuminance(bitmap) {
  if (typeof OffscreenCanvas === "undefined") {
    return 255;
  }
  const sampleW = 72;
  const scale = sampleW / Math.max(1, bitmap.width);
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return 255;

  ctx.drawImage(bitmap, 0, 0, width, height);
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    sum += lum;
    count += 1;
  }
  if (count < 1) return 255;
  return sum / count;
}

async function renderOcrVariantDataUrl(bitmap, opts = {}) {
  const scale = normalizeScale(bitmap.width, bitmap.height, opts.scale || 1);
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return "";

  ctx.drawImage(bitmap, 0, 0, width, height);
  const imageData = ctx.getImageData(0, 0, width, height);
  applyImageFilter(imageData, opts);
  ctx.putImageData(imageData, 0, 0);

  const blob = await canvas.convertToBlob({ type: "image/png" });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const base64 = bytesToBase64(bytes);
  return `data:image/png;base64,${base64}`;
}

async function buildOcrInputs(dataUrl) {
  const inputs = [{ name: "original", engine: 2, dataUrl }];
  if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap !== "function") {
    return inputs;
  }

  let bitmap = null;
  try {
    bitmap = await dataUrlToImageBitmap(dataUrl);
    const luminance = await estimateImageLuminance(bitmap);
    const isDarkBackground = luminance < 112;

    const colorUpscale = await renderOcrVariantDataUrl(bitmap, {
      scale: 1.72,
      grayscale: false,
      contrast: 1.12,
      brightness: 3
    });
    if (colorUpscale) {
      inputs.push({ name: "color_upscale", engine: 2, dataUrl: colorUpscale });
    }

    const grayContrast = await renderOcrVariantDataUrl(bitmap, {
      scale: 1.82,
      grayscale: true,
      contrast: 1.42,
      brightness: 8
    });
    if (grayContrast) {
      inputs.push({ name: "gray_contrast", engine: 2, dataUrl: grayContrast });
    }

    const grayBinary = await renderOcrVariantDataUrl(bitmap, {
      scale: 1.9,
      grayscale: true,
      contrast: 1.55,
      brightness: 12,
      threshold: 148
    });
    if (grayBinary) {
      inputs.push({ name: "gray_binary", engine: 2, dataUrl: grayBinary });
    }

    if (isDarkBackground) {
      const darkInvert = await renderOcrVariantDataUrl(bitmap, {
        scale: 1.78,
        grayscale: true,
        contrast: 1.28,
        brightness: 4,
        invert: true
      });
      if (darkInvert) {
        inputs.push({ name: "dark_invert", engine: 2, dataUrl: darkInvert });
      }
    }
  } catch (_e) {
    return inputs;
  } finally {
    try {
      bitmap?.close?.();
    } catch (_e) {
      // ignore
    }
  }

  return inputs;
}

function parseOcrSpaceError(json) {
  const e1 = json?.ErrorMessage;
  if (Array.isArray(e1) && e1.length > 0) return e1.join("; ");
  if (typeof e1 === "string" && e1.trim()) return e1.trim();
  const e2 = json?.ErrorDetails;
  if (Array.isArray(e2) && e2.length > 0) return e2.join("; ");
  if (typeof e2 === "string" && e2.trim()) return e2.trim();
  if (json?.IsErroredOnProcessing) return "OCR 处理失败";
  return "";
}

async function ocrByOcrSpace(dataUrl, options = {}) {
  const endpoint = "https://api.ocr.space/parse/image";
  const apiKey = options.apiKey || "helloworld";
  const language = options.language || "chs";
  const engine = Number(options.engine || 2);
  const timeoutMs = Math.max(3000, Number(options.timeoutMs || 12000));

  const form = new FormData();
  form.append("apikey", apiKey);
  form.append("language", language);
  form.append("base64Image", dataUrl);
  form.append("isOverlayRequired", "false");
  form.append("detectOrientation", "true");
  form.append("scale", "true");
  form.append("OCREngine", String(engine));

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      body: form,
      signal: ac.signal
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return {
        ok: false,
        error: `OCR_HTTP_${resp.status}`,
        provider: OCR_PROVIDER
      };
    }

    const text = parseOcrSpaceText(json);
    if (text) {
      return {
        ok: true,
        text,
        provider: OCR_PROVIDER
      };
    }

    return {
      ok: false,
      error: parseOcrSpaceError(json) || "OCR_EMPTY",
      provider: OCR_PROVIDER
    };
  } catch (e) {
    return {
      ok: false,
      error: String(e?.message || e || "OCR_REQUEST_FAILED"),
      provider: OCR_PROVIDER
    };
  } finally {
    clearTimeout(timer);
  }
}

function summarizeOcrAttempts(items) {
  return items.map((item) => ({
    variant: item.variant,
    engine: item.engine,
    ok: !!item.ok,
    score: Number(item.score || 0),
    length: Number(item.length || 0),
    error: item.error || ""
  }));
}

function buildOcrDiagnosticPayload(ocr) {
  const attempts = Array.isArray(ocr?.attempts) ? ocr.attempts : [];
  const ok = !!ocr?.ok;
  const summary = ok
    ? `识别成功（文本长度=${String(ocr?.text || "").length}）`
    : `识别失败（${String(ocr?.error || "unknown")}）`;

  return {
    mode: String(ocr?.mode || DEFAULT_OCR_MODE),
    summary,
    bestVariant: String(ocr?.variant || "-"),
    bestScore: Number(ocr?.score || 0),
    attempts
  };
}

function pickOcrInputsByMode(inputs, mode) {
  const list = Array.isArray(inputs) ? inputs.filter(Boolean) : [];
  if (!list.length) return [];
  if (mode === "fast") {
    return list.slice(0, 2);
  }
  if (mode === "accurate") {
    return list;
  }
  return list.slice(0, 4);
}

async function runOcrPipeline(dataUrl, options = {}) {
  const mode = normalizeOcrMode(options.mode);
  const allInputs = await buildOcrInputs(dataUrl);
  const inputs = pickOcrInputsByMode(allInputs, mode);

  const defaultTimeoutByMode = mode === "fast" ? 9000 : mode === "accurate" ? 26000 : 18000;
  const totalTimeout = Math.max(7000, Number(options.timeoutMs || defaultTimeoutByMode));
  const perAttemptTimeout = Math.max(2800, Math.floor(totalTimeout / Math.max(1, inputs.length)));
  const earlyStopScore = mode === "fast" ? 220 : mode === "accurate" ? 340 : 280;

  const attempts = [];
  for (const input of inputs) {
    const resp = await ocrByOcrSpace(input.dataUrl, {
      ...options,
      engine: input.engine,
      timeoutMs: perAttemptTimeout
    });

    if (resp.ok) {
      const text = cleanOcrText(resp.text || "");
      const score = scoreOcrText(text);
      const item = {
        ok: true,
        text,
        score,
        length: text.length,
        variant: input.name,
        engine: input.engine
      };
      attempts.push(item);

      // 到达较高置信度后直接收敛，降低延迟。
      if (score >= earlyStopScore) break;
    } else {
      attempts.push({
        ok: false,
        error: String(resp.error || "OCR_FAILED"),
        score: 0,
        length: 0,
        variant: input.name,
        engine: input.engine
      });
    }
  }

  const successList = attempts
    .filter((item) => item.ok)
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0));

  if (successList.length > 0) {
    const best = successList[0];
    return {
      ok: true,
      text: best.text,
      score: Number(best.score || 0),
      variant: best.variant,
      engine: best.engine,
      mode,
      provider: OCR_PROVIDER,
      attempts: summarizeOcrAttempts(attempts)
    };
  }

  const firstError = attempts.find((item) => !item.ok)?.error || "OCR_EMPTY";
  return {
    ok: false,
    error: firstError,
    mode,
    provider: OCR_PROVIDER,
    attempts: summarizeOcrAttempts(attempts)
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const type = msg?.type;
    const sessionId = normalizeSessionId(msg?.sessionId);
    const payload = msg?.payload || {};

    try {
      if (!type) return;

      if (type === MSG.OCR_REQUEST) {
        const dataUrl = await captureVisible();
        const ocr = await runOcrPipeline(dataUrl, payload || {});
        const ocrDiag = buildOcrDiagnosticPayload(ocr);

        if (ocr.ok) {
          sendStatus(
            sessionId,
            `OCR 识别成功：mode=${ocr.mode || DEFAULT_OCR_MODE}, variant=${ocr.variant || "original"}, score=${Number(
              ocr.score || 0
            )}, 文本长度=${String(ocr.text || "").length}`
            ,
            { ocrDiag }
          );
        } else {
          appendSessionError(sessionId, `OCR_FAILED: ${ocr.error || "unknown"}`);
          sendStatus(sessionId, `[OCR_FAILED] ${ocr.error || "unknown"}`, { ocrDiag });
        }

        sendResponse(ocr);
        return;
      }

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

        if (meta.exportPdf) {
          meta._pdfFrames.push({
            index,
            dataUrl,
            meta: {
              y: Number(payload.y || 0),
              viewport: Number(payload.viewport || 0),
              scrollHeight: Number(payload.scrollHeight || 0)
            }
          });
        }
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
        const extractMeta = payload.extractMeta || {};
        const extractSource = extractMeta.source || "dom";
        const extractReason = extractMeta.reason || "unknown";
        const finalLength = Number(extractMeta.finalLength || String(text).length || 0);
        const ocrMode = extractMeta.ocrMode || meta.ocrMode || DEFAULT_OCR_MODE;
        const ocrProvider = extractMeta.ocrProvider || "-";
        const ocrError = extractMeta.ocrError || "-";
        const ocrVariant = extractMeta.ocrVariant || "-";
        const ocrScore =
          Number.isFinite(Number(extractMeta.ocrScore)) && String(extractMeta.ocrScore || "") !== ""
            ? Number(extractMeta.ocrScore)
            : "-";
        const domQuality =
          Number.isFinite(Number(extractMeta.domQuality)) && String(extractMeta.domQuality || "") !== ""
            ? Number(extractMeta.domQuality)
            : "-";
        const finalQuality =
          Number.isFinite(Number(extractMeta.finalQuality)) && String(extractMeta.finalQuality || "") !== ""
            ? Number(extractMeta.finalQuality)
            : "-";

        const md =
`# ${title}

URL: ${url}

CapturedAt: ${new Date().toISOString()}

ExtractSource: ${extractSource}
ExtractReason: ${extractReason}
TextLength: ${finalLength}
OCRMode: ${ocrMode}
OCRProvider: ${ocrProvider}
OCRError: ${ocrError}
OCRVariant: ${ocrVariant}
OCRScore: ${ocrScore}
DOMQuality: ${domQuality}
FinalQuality: ${finalQuality}

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

        sendStatus(sessionId, "会话已完成。");
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
      if (type === MSG.OCR_REQUEST) {
        sendResponse({
          ok: false,
          error: String(e?.message || e || "OCR_REQUEST_FAILED"),
          provider: OCR_PROVIDER
        });
      }
    }
  })();

  return true;
});
