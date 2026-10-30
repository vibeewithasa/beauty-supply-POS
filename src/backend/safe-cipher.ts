/**
 * The protected-storage cipher of the application: Electron `safeStorage`, which on Windows is DPAPI (the encrypted blob can
 * only be decrypted by the same Windows user on the same machine). Main process only: the renderer never gets this.
 *
 * POS_TEST_CIPHER_UNAVAILABLE=1 simulates a machine without protected storage, to test the safe failure. Like the other test
 * knobs it is honored ONLY in development builds, never in a packaged app.
 */
import { app, safeStorage } from "electron";
import type { Cipher } from "./config-store";

export const safeCipher: Cipher = {
  available() {
    if (!app.isPackaged && process.env.POS_TEST_CIPHER_UNAVAILABLE === "1") return false;
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  },
  encrypt(plain) {
    return safeStorage.encryptString(plain).toString("base64");
  },
  decrypt(blob) {
    return safeStorage.decryptString(Buffer.from(blob, "base64"));
  },
};
