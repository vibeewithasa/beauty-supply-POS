// Per-device preference of the floating keypad. It lives in this window's localStorage (the Windows profile running the POS), never in
// the database (business_settings belongs to the installation, not to a device) and never goes through IPC. Reads and writes are
// guarded: a blocked or cleared store simply leaves the keypad off.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { DEFAULT_PREF, NUMPAD_STORAGE_KEY, parsePref, serializePref, type NumpadPref } from "./numpad";

interface NumpadApi {
  pref: NumpadPref;
  update: (patch: Partial<NumpadPref>) => void;
}

const read = (): NumpadPref => {
  try {
    return parsePref(window.localStorage.getItem(NUMPAD_STORAGE_KEY));
  } catch {
    return DEFAULT_PREF;
  }
};

const NumpadContext = createContext<NumpadApi | null>(null);

export function NumpadProvider({ children }: { children: ReactNode }) {
  const [pref, setPref] = useState<NumpadPref>(read);

  const update = useCallback((patch: Partial<NumpadPref>) => {
    setPref((prev) => {
      const next = { ...prev, ...patch };
      try {
        window.localStorage.setItem(NUMPAD_STORAGE_KEY, serializePref(next));
      } catch {
        /* the preference then lasts until the window closes */
      }
      return next;
    });
  }, []);

  // another window of the same profile changed it
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === NUMPAD_STORAGE_KEY) setPref(read());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const value = useMemo(() => ({ pref, update }), [pref, update]);
  return <NumpadContext.Provider value={value}>{children}</NumpadContext.Provider>;
}

export function useNumpadPref(): NumpadApi {
  const ctx = useContext(NumpadContext);
  if (!ctx) throw new Error("useNumpadPref must be used inside <NumpadProvider>");
  return ctx;
}
