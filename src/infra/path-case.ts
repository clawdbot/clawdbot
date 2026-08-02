// Detects path-local filesystem case semantics with a cleaned probe for empty directories.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function swapAsciiCase(value: string): string {
  return value.replace(/[A-Za-z]/g, (char) => {
    const lower = char.toLowerCase();
    return char === lower ? char.toUpperCase() : lower;
  });
}

function sameFsObject(a: fs.Stats, b: fs.Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function probeDirectoryEntry(dir: string, name: string): boolean | undefined {
  const swapped = swapAsciiCase(name);
  if (swapped === name) {
    return undefined;
  }
  try {
    const names = fs.readdirSync(dir);
    if (names.includes(name) && names.includes(swapped)) {
      return false;
    }
    const original = fs.lstatSync(path.join(dir, name));
    try {
      return sameFsObject(original, fs.lstatSync(path.join(dir, swapped)));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === "ENOENT" || code === "ENOTDIR" ? false : undefined;
    }
  } catch {
    return undefined;
  }
}

function probeDirectoryContents(dir: string): boolean | undefined {
  try {
    for (const name of fs.readdirSync(dir)) {
      const result = probeDirectoryEntry(dir, name);
      if (result !== undefined) {
        return result;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function probeDirectoryWithTemporaryEntry(dir: string): boolean | undefined {
  const name = `.openclaw-case-probe-${randomUUID()}`;
  const probePath = path.join(dir, name);
  let created = false;
  let result: boolean | undefined;
  try {
    fs.writeFileSync(probePath, "", { flag: "wx", mode: 0o600 });
    created = true;
    result = probeDirectoryEntry(dir, name);
  } catch {
    result = undefined;
  }
  if (created) {
    try {
      fs.unlinkSync(probePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  return result;
}

function platformDefault(): boolean {
  return process.platform === "darwin" || process.platform === "win32";
}

function probeDirectory(dir: string): boolean {
  return probeDirectoryContents(dir) ?? probeDirectoryWithTemporaryEntry(dir) ?? platformDefault();
}

/** Returns whether the target path's filesystem matches names case-insensitively. */
export function isPathCaseInsensitive(value: string): boolean {
  const resolved = path.resolve(value);
  try {
    fs.lstatSync(resolved);
    const parent = path.dirname(resolved);
    return probeDirectoryEntry(parent, path.basename(resolved)) ?? probeDirectory(parent);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      return platformDefault();
    }
  }

  let candidate = path.dirname(resolved);
  for (;;) {
    try {
      if (fs.statSync(candidate).isDirectory()) {
        return probeDirectory(candidate);
      }
    } catch {
      // Keep walking to the nearest readable existing directory.
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) {
      return platformDefault();
    }
    candidate = parent;
  }
}
