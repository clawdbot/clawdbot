import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

let indexedDBSetup = false;

/**
 * Matrix crypto store directory.
 * Default: ~/.clawdbot/matrix-crypto
 */
export function resolveMatrixCryptoDir(
  env: NodeJS.ProcessEnv = process.env,
  stateDir: string = resolveStateDir(env, os.homedir),
): string {
  const override = env.CLAWDBOT_MATRIX_CRYPTO_DIR?.trim();
  if (override) {
    const trimmed = override.trim();
    if (trimmed.startsWith("~")) {
      const expanded = trimmed.replace(/^~(?=$|[\\/])/, os.homedir());
      return path.resolve(expanded);
    }
    return path.resolve(trimmed);
  }
  return path.join(stateDir, "matrix-crypto");
}

/**
 * Ensure the crypto directory exists.
 */
export function ensureMatrixCryptoDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const dir = resolveMatrixCryptoDir(env);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Sanitize a user ID to be safe for use in a database prefix.
 * Removes special characters that could cause issues.
 */
export function sanitizeUserIdForPrefix(userId: string): string {
  // Replace @ and : with underscores for filesystem/db safety
  return userId.replace(/[@:]/g, "_").replace(/[^a-zA-Z0-9._-]/g, "");
}

/**
 * Set up fake-indexeddb for Node.js environment.
 * This must be called BEFORE initRustCrypto to allow the SDK to use IndexedDB.
 *
 * The crypto store will be persisted to ~/.clawdbot/matrix-crypto/.
 */
export async function setupNodeIndexedDB(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (indexedDBSetup) return;

  // Ensure the crypto directory exists
  ensureMatrixCryptoDir(env);

  // Import and set up fake-indexeddb
  const fakeIndexedDB = await import("fake-indexeddb");

  // Set global IndexedDB APIs that matrix-js-sdk will use
  const globalObj = globalThis as typeof globalThis & {
    indexedDB?: IDBFactory;
    IDBKeyRange?: typeof IDBKeyRange;
  };

  globalObj.indexedDB = fakeIndexedDB.default;
  globalObj.IDBKeyRange = fakeIndexedDB.IDBKeyRange;

  indexedDBSetup = true;
}

/**
 * Check if IndexedDB has been set up for Node.js.
 */
export function isNodeIndexedDBSetup(): boolean {
  return indexedDBSetup;
}

/**
 * Reset the IndexedDB setup state (for testing purposes).
 */
export function resetNodeIndexedDBSetup(): void {
  indexedDBSetup = false;
}
