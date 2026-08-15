// Shared bounded file readers for release E2E assertion scripts.
import fs from "node:fs";
import { readTextFileTail } from "./text-file-utils.mjs";

const SCAN_CHUNK_BYTES = 64 * 1024;
const SCAN_CARRY_CHARS = 256;
export const ERROR_DETAIL_TAIL_BYTES = 16 * 1024;
const JSON_ARTIFACT_MAX_BYTES = 2 * 1024 * 1024;

export function readJson(file, maxBytes = JSON_ARTIFACT_MAX_BYTES) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) {
    throw new Error(`${file} is not a file`);
  }
  if (stat.size > maxBytes) {
    throw new Error(
      `JSON artifact exceeded ${maxBytes} bytes: ${file} (${stat.size} bytes). Tail: ${readTextFileTail(
        file,
        ERROR_DETAIL_TAIL_BYTES,
      )}`,
    );
  }
  const text = fs.readFileSync(file, "utf8");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maxBytes) {
    throw new Error(
      `JSON artifact exceeded ${maxBytes} bytes: ${file} (${bytes} bytes). Tail: ${readTextFileTail(
        file,
        ERROR_DETAIL_TAIL_BYTES,
      )}`,
    );
  }
  return JSON.parse(text);
}

export function fileContainsText(file, needle) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile() || stat.size <= 0) {
    return false;
  }

  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(Math.min(SCAN_CHUNK_BYTES, stat.size));
    let carry = "";
    let offset = 0;
    while (offset < stat.size) {
      const bytesToRead = Math.min(buffer.length, stat.size - offset);
      const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, offset);
      if (bytesRead <= 0) {
        break;
      }
      offset += bytesRead;
      const text = carry + buffer.subarray(0, bytesRead).toString("utf8");
      if (text.includes(needle)) {
        return true;
      }
      carry = text.slice(-Math.max(SCAN_CARRY_CHARS, needle.length - 1));
    }
    return false;
  } finally {
    fs.closeSync(fd);
  }
}
