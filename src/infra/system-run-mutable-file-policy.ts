/** Filesystem heuristics for mutable executable and script operands. */
import fs from "node:fs";
import path from "node:path";
import { readFileWindowFullySync } from "./file-read.js";

function pathComponentsFromRootSync(targetPath: string): string[] {
  const parts: string[] = [];
  let cursor = path.resolve(targetPath);
  while (true) {
    parts.unshift(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      return parts;
    }
    cursor = parent;
  }
}

function isOwnedByCurrentProcessSync(candidate: string): boolean {
  if (process.platform === "win32" || typeof process.getuid !== "function") {
    return false;
  }
  try {
    return fs.statSync(candidate).uid === process.getuid();
  } catch {
    return false;
  }
}

function isMutableByCurrentProcessSync(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.W_OK);
    return true;
  } catch {
    return isOwnedByCurrentProcessSync(candidate);
  }
}

export function hasMutableSymlinkPathComponentSync(targetPath: string): boolean {
  for (const component of pathComponentsFromRootSync(targetPath)) {
    try {
      if (!fs.lstatSync(component).isSymbolicLink()) {
        continue;
      }
      if (isMutableByCurrentProcessSync(path.dirname(component))) {
        return true;
      }
    } catch {
      return true;
    }
  }
  return false;
}

export function pathLooksMutableForShellPayloadSync(targetPath: string): boolean {
  if (
    isMutableByCurrentProcessSync(targetPath) ||
    isMutableByCurrentProcessSync(path.dirname(targetPath)) ||
    hasMutableSymlinkPathComponentSync(targetPath)
  ) {
    return true;
  }
  let realPath: string;
  try {
    realPath = fs.realpathSync(targetPath);
  } catch {
    return true;
  }
  return (
    isMutableByCurrentProcessSync(realPath) ||
    isMutableByCurrentProcessSync(path.dirname(realPath)) ||
    hasMutableSymlinkPathComponentSync(realPath)
  );
}

export function looksLikePathToken(token: string): boolean {
  return (
    token.startsWith(".") ||
    token.startsWith("/") ||
    token.startsWith("\\") ||
    token.includes("/") ||
    token.includes("\\") ||
    path.extname(token).length > 0
  );
}

export function looksLikeExplicitPathToken(token: string): boolean {
  return (
    token.startsWith(".") ||
    token.startsWith("/") ||
    token.startsWith("\\") ||
    token.includes("/") ||
    token.includes("\\")
  );
}

export function resolvesToExistingFileSync(rawOperand: string, cwd: string | undefined): boolean {
  if (!rawOperand) {
    return false;
  }
  try {
    return fs.statSync(path.resolve(cwd ?? process.cwd(), rawOperand)).isFile();
  } catch {
    return false;
  }
}

function isKnownBinaryExecutableHeader(buffer: Buffer): boolean {
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    return true;
  }
  if (
    buffer.length >= 4 &&
    (buffer.subarray(0, 4).equals(Buffer.from([0xfe, 0xed, 0xfa, 0xce])) ||
      buffer.subarray(0, 4).equals(Buffer.from([0xce, 0xfa, 0xed, 0xfe])) ||
      buffer.subarray(0, 4).equals(Buffer.from([0xfe, 0xed, 0xfa, 0xcf])) ||
      buffer.subarray(0, 4).equals(Buffer.from([0xcf, 0xfa, 0xed, 0xfe])) ||
      buffer.subarray(0, 4).equals(Buffer.from([0xca, 0xfe, 0xba, 0xbe])) ||
      buffer.subarray(0, 4).equals(Buffer.from([0xbe, 0xba, 0xfe, 0xca])) ||
      buffer.subarray(0, 4).equals(Buffer.from([0xca, 0xfe, 0xba, 0xbf])) ||
      buffer.subarray(0, 4).equals(Buffer.from([0xbf, 0xba, 0xfe, 0xca])))
  ) {
    return true;
  }
  if (buffer.length < 0x40 || !buffer.subarray(0, 2).equals(Buffer.from([0x4d, 0x5a]))) {
    return false;
  }
  const peOffset = buffer.readUInt32LE(0x3c);
  return (
    peOffset >= 0 &&
    peOffset <= buffer.length - 4 &&
    buffer.subarray(peOffset, peOffset + 4).equals(Buffer.from([0x50, 0x45, 0x00, 0x00]))
  );
}

export function isLikelyScriptLikePathSync(targetPath: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(targetPath);
  } catch {
    return true;
  }
  if (!stat.isFile()) {
    return true;
  }
  let header: Buffer;
  try {
    const fd = fs.openSync(targetPath, "r");
    try {
      header = Buffer.alloc(1024);
      const bytesRead = readFileWindowFullySync(fd, header, 0);
      header = header.subarray(0, bytesRead);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return true;
  }
  if (header.length === 0 || header.subarray(0, 2).equals(Buffer.from("#!"))) {
    return true;
  }
  return !isKnownBinaryExecutableHeader(header);
}
