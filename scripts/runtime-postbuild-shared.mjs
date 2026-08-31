// Shared filesystem helpers for runtime postbuild scripts.
import fs from "node:fs";
import { dirname } from "node:path";

/**
 * Writes text only when contents changed and returns whether a write happened.
 */
export function writeTextFileIfChanged(filePath, contents) {
  const next = String(contents);
  try {
    const current = fs.readFileSync(filePath, "utf8");
    if (current === next) {
      return false;
    }
  } catch {
    // Write the file when it does not exist or cannot be read.
  }
  fs.mkdirSync(dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, next, "utf8");
  return true;
}

/**
 * Removes one file if present, treating missing paths as success.
 */
export function removeFileIfExists(filePath) {
  try {
    fs.rmSync(filePath, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes a file or directory tree if present.
 */
export function removePathIfExists(filePath) {
  try {
    fs.rmSync(filePath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
