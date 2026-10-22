// Keyboard shortcuts: one table, used both to act on key presses and to list them in the help.
//
// Drawing tools use Alt + a letter, like TradingView. Keys are matched on `event.code`
// (the physical key), because with Alt held some keyboards turn the letter into
// another character. Ctrl and the Mac's Cmd count as the same key.
// Shortcuts are ignored while typing in a box (main.js checks that first).

export const SHORTCUTS = [
  { keys: "Alt + T", code: "KeyT", alt: true, action: "tool:trend", label: "Trendline" },
  { keys: "Alt + R", code: "KeyR", alt: true, action: "tool:ray", label: "Ray" },
  { keys: "Alt + H", code: "KeyH", alt: true, action: "tool:hline", label: "Horizontal line" },
  { keys: "Alt + J", code: "KeyJ", alt: true, action: "tool:hray", label: "Horizontal ray" },
  { keys: "Alt + V", code: "KeyV", alt: true, action: "tool:vline", label: "Vertical line" },
  { keys: "Alt + B", code: "KeyB", alt: true, action: "tool:rect", label: "Rectangle (box)" },
  { keys: "Alt + F", code: "KeyF", alt: true, action: "tool:fib", label: "Fibonacci retracement" },
  { keys: "Alt + L", code: "KeyL", alt: true, action: "tool:long", label: "Long position" },
  { keys: "Alt + S", code: "KeyS", alt: true, action: "tool:short", label: "Short position" },
  { keys: "Alt + N", code: "KeyN", alt: true, action: "tool:text", label: "Text note" },
  { keys: "Alt + Q", code: "KeyQ", alt: true, action: "tool:measure", label: "Measure (price change, pips, bars and time); Shift + click also measures" },
  { keys: "Alt + M", code: "KeyM", alt: true, action: "magnet", label: "Magnet on or off (pulls a point to a nearby open, high, low or close)" },
  { keys: "Ctrl + Z", code: "KeyZ", ctrl: true, action: "undo", label: "Undo the last drawing change" },
  { keys: "Ctrl + Y", code: "KeyY", ctrl: true, action: "redo", label: "Redo" },
  { keys: "Ctrl + Shift + Z", code: "KeyZ", ctrl: true, shift: true, action: "redo", label: "Redo" },
  { keys: "?", code: "Slash", shift: true, action: "help", label: "This list" },
];

/** Keys handled elsewhere, listed in the help so it is complete. */
export const OTHER_KEYS = [
  { keys: "Esc", label: "Cancel: a drag, a tool, a selection, a pick" },
  { keys: "Delete", label: "Delete the selected drawing" },
  { keys: "Hold Ctrl", label: "While drawing or dragging a point: magnet the other way for that move" },
  { keys: "Space", label: "Replay: play or pause" },
  { keys: "→ / ←", label: "Replay: one chart candle forward / back" },
  { keys: "Shift + →", label: "Replay: one M5 candle forward" },
  { keys: "End", label: "Replay: back to the live candle" },
];

/** The action for a key press, or null. Modifiers must match exactly, so Ctrl + Z is not Ctrl + Shift + Z. */
export function shortcutFor(event) {
  const ctrl = !!(event.ctrlKey || event.metaKey);
  for (const s of SHORTCUTS) {
    if (event.code === s.code && ctrl === !!s.ctrl && !!event.altKey === !!s.alt && !!event.shiftKey === !!s.shift) return s.action;
  }
  return null;
}
