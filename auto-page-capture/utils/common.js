// utils/common.js (global version)
window.APC = window.APC || {};

window.APC.MSG = {
  START_CAPTURE: "START_CAPTURE",
  STOP_CAPTURE: "STOP_CAPTURE",

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

window.APC.nowSessionId = function () {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const ts =
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    "_" +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds());
  const rand = Math.random().toString(16).slice(2, 8).toUpperCase();
  return `${ts}_${rand}`;
};

window.APC.sleep = function (ms) {
  return new Promise((r) => setTimeout(r, ms));
};

window.APC.safeName = function (s) {
  return String(s || "").replace(/[:/\\?*"<>|]/g, "_").slice(0, 120);
};
