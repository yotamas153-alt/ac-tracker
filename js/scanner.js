// ===================================================================
//  scanner.js — camera barcode / QR scanning (html5-qrcode wrapper)
//  Exposes a single startScan() that resolves with the decoded text.
// ===================================================================

let html5QrCode = null;
let running = false;

/**
 * Open the camera, scan one code, then stop.
 * @param {string} readerId  id of the container element
 * @param {(text:string)=>void} onResult  called with the decoded value
 */
export async function startScan(readerId, onResult) {
  const reader = document.getElementById(readerId);
  if (!reader) return;
  reader.hidden = false;

  if (typeof Html5Qrcode === "undefined") {
    alert("ספריית הסריקה לא נטענה. בדוק חיבור לאינטרנט.");
    reader.hidden = true;
    return;
  }

  if (!html5QrCode) html5QrCode = new Html5Qrcode(readerId);
  if (running) return;

  try {
    running = true;
    await html5QrCode.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 250, height: 250 } },
      async (decodedText) => {
        await stopScan(readerId);
        onResult(decodedText.trim());
      },
      () => { /* ignore per-frame decode errors */ }
    );
  } catch (err) {
    console.error(err);
    running = false;
    reader.hidden = true;
    alert("לא ניתן לפתוח את המצלמה. ודא שנתת הרשאה ושאתה על HTTPS.");
  }
}

export async function stopScan(readerId) {
  const reader = document.getElementById(readerId);
  try {
    if (html5QrCode && running) await html5QrCode.stop();
  } catch (_) { /* already stopped */ }
  running = false;
  if (reader) reader.hidden = true;
}
