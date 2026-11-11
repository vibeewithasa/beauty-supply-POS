// Floating numeric keypad for the sales screen. A plain element above the page (no operating-system window).
//
// It is an aid for touch and mouse: it types into the ONE field that has the focus, and only into fields that opted in with
// data-numpad="integer|decimal". It never takes the focus itself (so a barcode reader keeps typing where it was typing, and the
// physical keyboard keeps working), its keys are not tab stops, and it has no Enter key (paying stays an explicit button).
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Delete, Minus } from "lucide-react";
import { useNumpadPref } from "@/lib/numpad-context";
import { applyKey, clampPosition, defaultPosition, numpadMode, type NumpadKey, type NumpadMode } from "@/lib/numpad";

const ROOT_ATTR = "data-numpad-root";
const FULL = { w: 232, h: 380 };
const CHIP = { w: 56, h: 56 };
const DRAG_THRESHOLD = 4;
const KEYS: NumpadKey[] = ["7", "8", "9", "4", "5", "6", "1", "2", "3", ".", "0", "backspace"];

const modeOf = (el: HTMLInputElement): NumpadMode | null =>
  numpadMode({
    numpad: el.getAttribute("data-numpad"),
    type: el.type,
    readOnly: el.readOnly,
    disabled: el.disabled,
    ignored: el.closest("[data-numpad-ignore]") !== null,
  });

const labelOf = (el: HTMLInputElement) => el.getAttribute("aria-label") ?? el.labels?.[0]?.textContent?.trim() ?? "campo numérico";

export function Numpad() {
  const { pref, update } = useNumpadPref();
  const rootRef = useRef<HTMLDivElement>(null);
  const [target, setTarget] = useState<HTMLInputElement | null>(null);
  const replaceNext = useRef(true);
  const [vp, setVp] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [size, setSize] = useState(FULL);
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const gesture = useRef<{ px: number; py: number; ox: number; oy: number; moved: boolean } | null>(null);

  useEffect(() => {
    const onResize = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // The field being typed into is the focused one, and only if it opted in. Focus anywhere else (the search box, another input)
  // or losing it detaches the keypad, so a key can never land in a field the operator is no longer working on.
  useEffect(() => {
    if (!pref.enabled) return;
    const onFocusIn = (e: FocusEvent) => {
      const el = e.target;
      if (!(el instanceof HTMLInputElement) || el.closest(`[${ROOT_ATTR}]`)) return;
      replaceNext.current = true;
      setTarget(modeOf(el) ? el : null);
    };
    const onFocusOut = (e: FocusEvent) => {
      if (!(e.relatedTarget instanceof Element && e.relatedTarget.closest(`[${ROOT_ATTR}]`))) setTarget(null);
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    const active = document.activeElement;
    if (active instanceof HTMLInputElement && modeOf(active)) setTarget(active);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, [pref.enabled]);

  // a dialog closing removes its field without a focus event
  useEffect(() => {
    if (!target) return;
    const mo = new MutationObserver(() => {
      if (!target.isConnected) setTarget(null);
    });
    mo.observe(document.body, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [target]);

  useLayoutEffect(() => {
    const r = rootRef.current?.getBoundingClientRect();
    if (r && (Math.round(r.width) !== size.w || Math.round(r.height) !== size.h)) setSize({ w: Math.round(r.width), h: Math.round(r.height) });
  });

  const mode = target ? modeOf(target) : null;

  const press = useCallback(
    (key: NumpadKey) => {
      const el = target;
      const m = el ? modeOf(el) : null;
      if (!el || !m || !el.isConnected) return;
      const sel = (() => {
        try {
          return { s: el.selectionStart, e: el.selectionEnd };
        } catch {
          return { s: null, e: null }; // type="number" exposes no selection
        }
      })();
      const out = applyKey({ value: el.value, selStart: sel.s, selEnd: sel.e, replace: replaceNext.current }, key, m);
      // the screens use controlled inputs: set through the native setter and announce it like a typed character
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(el, out.value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.focus({ preventScroll: true });
      try {
        if (el.selectionStart !== null) el.setSelectionRange(out.caret, out.caret);
      } catch {
        /* number inputs */
      }
      replaceNext.current = out.value === ""; // an emptied field is typed over, not appended to
    },
    [target]
  );

  if (!pref.enabled) return null;

  const box = pref.minimized ? CHIP : { w: size.w, h: size.h };
  const base = pref.x !== null && pref.y !== null ? { x: pref.x, y: pref.y } : defaultPosition(box.w, box.h, vp.w, vp.h);
  const pos = drag ?? clampPosition(base.x, base.y, box.w, box.h, vp.w, vp.h);

  const onHandleDown = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    gesture.current = { px: e.clientX, py: e.clientY, ox: pos.x, oy: pos.y, moved: false };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* a pointer that is already gone: the drag simply follows the events it still gets */
    }
  };
  const onHandleMove = (e: React.PointerEvent<HTMLElement>) => {
    const g = gesture.current;
    if (!g) return;
    const dx = e.clientX - g.px;
    const dy = e.clientY - g.py;
    if (!g.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    g.moved = true;
    setDrag(clampPosition(g.ox + dx, g.oy + dy, box.w, box.h, vp.w, vp.h));
  };
  const onHandleUp = (e: React.PointerEvent<HTMLElement>, onTap?: () => void) => {
    const g = gesture.current;
    gesture.current = null;
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* nothing was captured */
    }
    if (g?.moved && drag) update({ x: drag.x, y: drag.y });
    else if (g) onTap?.();
    setDrag(null);
  };

  const keyClass =
    "h-14 rounded-lg border border-input bg-background text-xl font-semibold text-foreground active:bg-primary active:text-primary-foreground disabled:opacity-40 disabled:active:bg-background disabled:active:text-foreground";

  const root = (
    <div
      ref={rootRef}
      {...{ [ROOT_ATTR]: "" }}
      role="group"
      aria-label="Teclado numérico"
      style={{ left: pos.x, top: pos.y, width: pref.minimized ? CHIP.w : FULL.w, touchAction: "none", pointerEvents: "auto" }}
      className="fixed z-[60] select-none"
      // The keypad is never a focus target: pressing anywhere on it must not blur the field being typed into. The pointer events
      // stop here so an open Radix dialog does not read a tap on the keypad as a click outside and close itself.
      onMouseDown={(e) => e.preventDefault()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {pref.minimized ? (
        <button
          type="button"
          tabIndex={-1}
          aria-label="Mostrar teclado numérico"
          data-testid="numpad-chip"
          onPointerDown={onHandleDown}
          onPointerMove={onHandleMove}
          onPointerUp={(e) => onHandleUp(e, () => update({ minimized: false }))}
          className="flex h-14 w-14 cursor-grab items-center justify-center rounded-full border-2 border-primary-foreground/30 bg-primary text-lg font-bold text-primary-foreground shadow-2xl"
        >
          123
        </button>
      ) : (
        <div className="rounded-xl border-2 border-input bg-card p-2 shadow-2xl" data-testid="numpad">
          <div className="mb-2 flex items-center gap-2">
            <div
              data-testid="numpad-handle"
              aria-hidden="true"
              onPointerDown={onHandleDown}
              onPointerMove={onHandleMove}
              onPointerUp={(e) => onHandleUp(e)}
              className="flex h-12 flex-1 cursor-grab items-center justify-center rounded-lg bg-primary text-sm font-semibold text-primary-foreground"
            >
              ⋮⋮ Teclado
            </div>
            <button
              type="button"
              tabIndex={-1}
              aria-label="Minimizar teclado numérico"
              data-testid="numpad-minimize"
              onClick={() => update({ minimized: true })}
              className="flex h-12 w-12 items-center justify-center rounded-lg border border-input bg-background"
            >
              <Minus size={20} />
            </button>
          </div>
          <p role="status" aria-live="polite" data-testid="numpad-status" className="mb-2 h-5 truncate text-xs text-muted-foreground">
            {target && mode ? `Escribiendo en: ${labelOf(target)}` : "Toca un campo numérico"}
          </p>
          <div className="grid grid-cols-3 gap-2">
            {KEYS.map((k) => {
              const off = !mode || (k === "." && mode !== "decimal");
              return (
                <button
                  key={k}
                  type="button"
                  tabIndex={-1}
                  disabled={off}
                  data-key={k}
                  aria-label={k === "backspace" ? "Borrar un dígito" : k === "." ? "Punto decimal" : `Dígito ${k}`}
                  onClick={() => press(k)}
                  className={keyClass + " flex items-center justify-center"}
                >
                  {k === "backspace" ? <Delete size={22} /> : k}
                </button>
              );
            })}
            <button type="button" tabIndex={-1} disabled={!mode} data-key="clear" aria-label="Borrar todo el campo" onClick={() => press("clear")} className={keyClass + " col-span-3 h-12 text-base"}>
              Borrar todo
            </button>
          </div>
        </div>
      )}
    </div>
  );
  return createPortal(root, document.body);
}
