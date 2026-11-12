// Pure rules of the floating numeric keypad: no React, no DOM, no IPC (unit tested in e2e/unit/numpad.test.mjs).

export type NumpadMode = "integer" | "decimal";
export type NumpadKey = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "." | "backspace" | "clear";

export const NUMPAD_STORAGE_KEY = "pos.numpad.v1";

// Same shapes the screens already accept: cash received is /^\d{1,9}(\.\d{1,2})?$/, quantities are whole numbers.
const SHAPES: Record<NumpadMode, RegExp> = { integer: /^\d{0,9}$/, decimal: /^\d{0,9}(\.\d{0,2})?$/ };

export interface FieldState {
  value: string;
  /** null for inputs that expose no selection (type="number"): the key then edits the end of the value. */
  selStart: number | null;
  selEnd: number | null;
  /** The first key after a field gets focus replaces its content (typing "5" over a quantity of "1" gives "5", not "15"). */
  replace: boolean;
}

/** The new value after one key, and where the caret goes. A key that would make the value invalid changes nothing. */
export function applyKey(field: FieldState, key: NumpadKey, mode: NumpadMode): { value: string; caret: number } {
  const { value } = field;
  const len = value.length;
  const unchanged = { value, caret: Math.min(field.selEnd ?? len, len) };
  let start = field.replace ? 0 : Math.min(field.selStart ?? len, len);
  let end = field.replace ? len : Math.min(field.selEnd ?? len, len);
  if (start > end) [start, end] = [end, start];

  if (key === "clear") return { value: "", caret: 0 };
  if (key === "backspace") {
    if (start === end) {
      if (start === 0) return unchanged;
      start -= 1;
    }
    return { value: value.slice(0, start) + value.slice(end), caret: start };
  }
  if (key === "." && mode !== "decimal") return unchanged;
  if (key !== "." && !/^[0-9]$/.test(key)) return unchanged;

  let next = value.slice(0, start) + key + value.slice(end);
  let caret = start + 1;
  if (next.startsWith(".")) {
    next = "0" + next;
    caret += 1;
  }
  const zeros = /^0+(?=\d)/.exec(next)?.[0].length ?? 0; // "05" -> "5"
  if (zeros) {
    next = next.slice(zeros);
    caret = Math.max(0, caret - zeros);
  }
  if (!SHAPES[mode].test(next)) return unchanged;
  return { value: next, caret };
}

export interface FieldTraits {
  /** The value of the field's data-numpad attribute (null when absent). */
  numpad: string | null;
  type: string;
  readOnly: boolean;
  disabled: boolean;
  /** Inside an element marked data-numpad-ignore. */
  ignored: boolean;
}

/**
 * Which fields the keypad may type into. Never inferred (inputMode, type): a field takes part only when its screen marks it with
 * data-numpad. Searches (the barcode reader types there), PINs and anything read-only or disabled are out by construction.
 */
export function numpadMode(t: FieldTraits): NumpadMode | null {
  if (t.readOnly || t.disabled || t.ignored) return null;
  if (t.type === "password") return null;
  return t.numpad === "integer" || t.numpad === "decimal" ? t.numpad : null;
}

export interface NumpadPref {
  enabled: boolean;
  minimized: boolean;
  /** Top-left corner in CSS pixels; null until the operator moves the keypad (it then opens at the bottom-left). */
  x: number | null;
  y: number | null;
}
export const DEFAULT_PREF: NumpadPref = { enabled: false, minimized: false, x: null, y: null };

/** Anything unreadable, corrupt or hand-edited falls back to the defaults (keypad off). */
export function parsePref(raw: string | null | undefined): NumpadPref {
  if (!raw) return DEFAULT_PREF;
  try {
    const o = JSON.parse(raw);
    if (typeof o !== "object" || o === null || Array.isArray(o)) return DEFAULT_PREF;
    const coord = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 100000 ? Math.round(v) : null);
    const x = coord(o.x);
    const y = coord(o.y);
    return { enabled: o.enabled === true, minimized: o.minimized === true, x: x === null || y === null ? null : x, y: x === null || y === null ? null : y };
  } catch {
    return DEFAULT_PREF;
  }
}

export const serializePref = (p: NumpadPref) => JSON.stringify({ enabled: p.enabled, minimized: p.minimized, x: p.x, y: p.y });

export const EDGE = 8;

/** Keeps a box of w x h entirely inside the window (it never ends up where it cannot be reached). Too small a window pins it to the top-left edge. */
export function clampPosition(x: number, y: number, w: number, h: number, vw: number, vh: number): { x: number; y: number } {
  const maxX = Math.max(EDGE, vw - w - EDGE);
  const maxY = Math.max(EDGE, vh - h - EDGE);
  return { x: Math.min(Math.max(Math.round(x), EDGE), maxX), y: Math.min(Math.max(Math.round(y), EDGE), maxY) };
}

/**
 * Where the keypad sits when it has never been moved: bottom-left corner, under the search box. The right side of the sales screen holds the cart
 * and the Pay button, which a keypad there would cover at 1024x768.
 */
export const defaultPosition = (w: number, h: number, vw: number, vh: number) => clampPosition(16, vh - h - 16, w, h, vw, vh);
