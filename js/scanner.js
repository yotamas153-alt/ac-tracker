// ===================================================================
//  scanner.js — global barcode / QR scanner overlay
//  Works from ANY screen (search or add). Uses html5-qrcode with the
//  native BarcodeDetector when available + explicit 1D/2D formats for
//  reliable detection, plus a manual-entry fallback.
// ===================================================================

let html5QrCode = null;
let running = false;
let resultCb = null;
let wired = false;

/** Supported symbologies — QR plus the common linear barcodes on asset tags. */
function supportedFormats() {
  const F = window.Html5QrcodeSupportedFormats;
  if (!F) return undefined; // library not loaded yet → default set
  return [
    F.QR_CODE, F.DATA_MATRIX, F.AZTEC,
    F.CODE_128, F.CODE_39, F.CODE_93,
    F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E,
    F.ITF, F.CODABAR,
  ];
}

/**
 * Open the scanner overlay and scan one code.
 * @param {(text:string)=>void} onResult  called with the decoded/typed value
 */
export async function startScan(onResult) {
  resultCb = onResult;
  wireOnce();

  const overlay = document.getElementById("scanOverlay");
  const reader  = document.getElementById("scanReader");
  overlay.hidden = false;
  reader.innerHTML = "";

  if (typeof Html5Qrcode === "undefined") {
    reader.innerHTML = `<div class="scan-nolib">📴 המצלמה אינה זמינה כרגע.<br>ניתן להקליד ברקוד ידנית למטה ↓</div>`;
    return;
  }

  if (!html5QrCode) {
    html5QrCode = new Html5Qrcode("scanReader", {
      formatsToSupport: supportedFormats(),
      experimentalFeatures: { useBarCodeDetectorIfSupported: true },
      verbose: false,
    });
  }
  if (running) return;

  try {
    running = true;
    await html5QrCode.start(
      { facingMode: "environment" },
      {
        fps: 12,
        // responsive scan box ~72% of the smaller viewport dimension
        qrbox: (vw, vh) => {
          const m = Math.max(180, Math.floor(Math.min(vw, vh) * 0.72));
          return { width: m, height: m };
        },
        aspectRatio: 1.0,
      },
      async (decodedText) => { await stopScan(); finish(decodedText); },
      () => { /* per-frame decode misses — ignore */ }
    );
  } catch (err) {
    console.error("scan start failed:", err);
    running = false;
    reader.innerHTML = `<div class="scan-nolib">🚫 לא ניתן לפתוח את המצלמה.<br>ודא הרשאת מצלמה ושהאתר ב-HTTPS.<br>ניתן להקליד ברקוד ידנית למטה ↓</div>`;
  }
}

/** Stop the camera (safe to call anytime). */
export async function stopScan() {
  try { if (html5QrCode && running) await html5QrCode.stop(); }
  catch (_) { /* already stopped */ }
  running = false;
}

function hideOverlay() {
  const o = document.getElementById("scanOverlay");
  if (o) o.hidden = true;
}

function finish(text) {
  const cb = resultCb;
  resultCb = null;
  hideOverlay();
  const val = String(text ?? "").trim();
  if (cb && val) cb(val);
}

/** Attach overlay controls once. */
function wireOnce() {
  if (wired) return;
  wired = true;

  document.getElementById("scanClose").addEventListener("click", async () => {
    await stopScan();
    resultCb = null;
    hideOverlay();
  });

  document.getElementById("scanManual").addEventListener("submit", async (e) => {
    e.preventDefault();
    const val = e.target.manual.value.trim();
    e.target.reset();
    if (!val) return;
    await stopScan();
    finish(val);
  });
}
