// Chart screenshots for the journal.
//
// The chart library draws the candles, sessions, trade lines and drawings into one picture
// (`takeScreenshot`). A strip on top says what the picture is, because the legend in the
// corner of the chart is ordinary page text and is not in the library's picture.
// Pictures are kept by the store (store.js): files under strategies/<journal>/screenshots/ in the desktop app.

const STRIP = 26;

/**
 * A PNG of the chart (or of two charts side by side, with a 2px gap) with a caption strip on top.
 * `charts` is one chart or a list of them. Resolves to a Blob.
 */
export function capture(charts, caption) {
  const shots = (Array.isArray(charts) ? charts : [charts]).map((c) => c.takeScreenshot());
  const GAP = 2;
  const canvas = document.createElement("canvas");
  canvas.width = shots.reduce((w, s) => w + s.width, 0) + GAP * (shots.length - 1);
  canvas.height = Math.max(...shots.map((s) => s.height)) + STRIP;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#1a1a1a";
  ctx.fillRect(0, 0, canvas.width, STRIP);
  ctx.fillStyle = "#dbdbdb";
  ctx.font = '13px -apple-system, "Segoe UI", Roboto, sans-serif';
  ctx.textBaseline = "middle";
  ctx.fillText(caption, 10, STRIP / 2);
  ctx.fillStyle = "#1a1a1a"; // the gap between charts shows as the strip colour
  ctx.fillRect(0, STRIP, canvas.width, canvas.height - STRIP);
  let x = 0;
  for (const shot of shots) {
    ctx.drawImage(shot, x, STRIP);
    x += shot.width + GAP;
  }
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("the browser made no picture"))), "image/png"));
}
