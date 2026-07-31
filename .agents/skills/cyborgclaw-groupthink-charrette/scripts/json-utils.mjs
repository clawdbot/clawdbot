import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";

export const MAX_JSON_BYTES = 4 * 1024 * 1024;
export const MAX_JSON_DEPTH = 128;
export const MAX_JSON_NODES = 100_000;
export const MAX_RECORD_JSON_BYTES = 64 * 1024 * 1024;
export const MAX_RECORD_JSON_DEPTH = 160;
export const MAX_RECORD_JSON_NODES = 500_000;

export class ContractError extends Error {
  constructor(message, code = "CONTRACT_ERROR") {
    super(message);
    this.name = "ContractError";
    this.code = code;
  }
}

export function assertUnicodeScalarString(value, source = "<string>") {
  if (typeof value !== "string") {
    throw new ContractError(`${source}: expected string`, "INVALID_JSON");
  }
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new ContractError(`${source}: unpaired UTF-16 surrogate`, "INVALID_JSON");
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new ContractError(`${source}: unpaired UTF-16 surrogate`, "INVALID_JSON");
    }
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function canonicalValue(value) {
  let nodes = 0;
  function visit(item, depth) {
    if (depth > MAX_RECORD_JSON_DEPTH) {
      throw new ContractError(
        `Canonical JSON exceeds depth ${MAX_RECORD_JSON_DEPTH}`,
        "INVALID_JSON",
      );
    }
    nodes += 1;
    if (nodes > MAX_RECORD_JSON_NODES) {
      throw new ContractError(
        `Canonical JSON exceeds node count ${MAX_RECORD_JSON_NODES}`,
        "INVALID_JSON",
      );
    }
    if (item === null || typeof item === "boolean") {
      return item;
    }
    if (typeof item === "string") {
      return assertUnicodeScalarString(item, "canonical JSON string");
    }
    if (typeof item === "number") {
      if (
        !Number.isFinite(item) ||
        (Number.isInteger(item) && !Number.isSafeInteger(item)) ||
        Object.is(item, -0)
      ) {
        throw new ContractError("Non-canonical or precision-losing JSON number", "INVALID_JSON");
      }
      return item;
    }
    if (Array.isArray(item)) {
      return item.map((value) => visit(value, depth + 1));
    }
    if (typeof item === "object") {
      for (const key of Object.keys(item)) {
        assertUnicodeScalarString(key, "canonical JSON object key");
      }
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, visit(item[key], depth + 1)]),
      );
    }
    throw new ContractError(`Unsupported JSON value type: ${typeof item}`);
  }
  return visit(value, 0);
}

export function sha256(value) {
  if (typeof value === "string") {
    assertUnicodeScalarString(value, "SHA-256 input");
  }
  return createHash("sha256").update(value).digest("hex");
}

export function digestJson(value) {
  return sha256(canonicalJson(value));
}

export function decodeUtf8Strict(bytes, source = "<json>", maxBytes = MAX_JSON_BYTES) {
  if (!(bytes instanceof Uint8Array)) {
    throw new ContractError(`${source}: expected bytes`, "INVALID_JSON");
  }
  if (bytes.byteLength > maxBytes) {
    throw new ContractError(`${source}: input exceeds ${maxBytes} byte limit`, "INVALID_JSON");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ContractError(`${source}: malformed UTF-8`, "INVALID_JSON");
  }
}

export function parseJsonStrict(
  text,
  source = "<json>",
  { maxBytes = MAX_JSON_BYTES, maxDepth = MAX_JSON_DEPTH, maxNodes = MAX_JSON_NODES } = {},
) {
  if (typeof text !== "string") {
    throw new ContractError(`${source}: expected JSON text`, "INVALID_JSON");
  }
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new ContractError(`${source}: input exceeds ${maxBytes} byte limit`, "INVALID_JSON");
  }
  let index = 0;
  let nodes = 0;

  function fail(message) {
    throw new ContractError(`${source}:${index + 1}: ${message}`, "INVALID_JSON");
  }

  function countNode(depth) {
    if (depth > maxDepth) {
      fail(`maximum nesting depth ${maxDepth} exceeded`);
    }
    nodes += 1;
    if (nodes > maxNodes) {
      fail(`maximum node count ${maxNodes} exceeded`);
    }
  }

  function skipWhitespace() {
    while (index < text.length && /[\t\n\r ]/.test(text[index])) {
      index += 1;
    }
  }

  function parseString() {
    const start = index;
    if (text[index] !== '"') {
      fail("expected string");
    }
    index += 1;
    while (index < text.length) {
      const character = text[index];
      if (character === '"') {
        index += 1;
        try {
          return assertUnicodeScalarString(
            JSON.parse(text.slice(start, index)),
            `${source}:${start + 1}`,
          );
        } catch {
          fail("invalid string escape");
        }
      }
      if (character === "\\") {
        index += 2;
      } else {
        if (character.charCodeAt(0) < 0x20) {
          fail("unescaped control character in string");
        }
        index += 1;
      }
    }
    fail("unterminated string");
  }

  function parseArray(depth) {
    const result = [];
    index += 1;
    skipWhitespace();
    if (text[index] === "]") {
      index += 1;
      return result;
    }
    while (index < text.length) {
      result.push(parseValue(depth + 1));
      skipWhitespace();
      if (text[index] === "]") {
        index += 1;
        return result;
      }
      if (text[index] !== ",") {
        fail("expected ',' or ']'");
      }
      index += 1;
      skipWhitespace();
    }
    fail("unterminated array");
  }

  function parseObject(depth) {
    // A null prototype prevents keys such as "__proto__" from changing parser state.
    const result = Object.create(null);
    const keys = new Set();
    index += 1;
    skipWhitespace();
    if (text[index] === "}") {
      index += 1;
      return result;
    }
    while (index < text.length) {
      if (text[index] !== '"') {
        fail("expected object key");
      }
      const key = parseString();
      if (keys.has(key)) {
        throw new ContractError(
          `${source}: duplicate object key ${JSON.stringify(key)}`,
          "DUPLICATE_JSON_KEY",
        );
      }
      keys.add(key);
      skipWhitespace();
      if (text[index] !== ":") {
        fail("expected ':'");
      }
      index += 1;
      result[key] = parseValue(depth + 1);
      skipWhitespace();
      if (text[index] === "}") {
        index += 1;
        return result;
      }
      if (text[index] !== ",") {
        fail("expected ',' or '}'");
      }
      index += 1;
      skipWhitespace();
    }
    fail("unterminated object");
  }

  function parseNumber() {
    const match = text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!match) {
      fail("invalid number");
    }
    index += match[0].length;
    const value = Number(match[0]);
    if (
      !Number.isFinite(value) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value)) ||
      JSON.stringify(value) !== match[0]
    ) {
      fail("non-canonical or precision-losing number");
    }
    return value;
  }

  function parseValue(depth) {
    countNode(depth);
    skipWhitespace();
    const character = text[index];
    if (character === '"') {
      return parseString();
    }
    if (character === "{") {
      return parseObject(depth);
    }
    if (character === "[") {
      return parseArray(depth);
    }
    if (character === "-" || /[0-9]/.test(character ?? "")) {
      return parseNumber();
    }
    for (const [literal, value] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ]) {
      if (text.startsWith(literal, index)) {
        index += literal.length;
        return value;
      }
    }
    fail("unexpected token");
  }

  try {
    const value = parseValue(0);
    skipWhitespace();
    if (index !== text.length) {
      fail("trailing content");
    }
    return value;
  } catch (error) {
    if (error instanceof ContractError) {
      throw error;
    }
    if (error instanceof RangeError) {
      throw new ContractError(`${source}: JSON nesting exceeds parser limits`, "INVALID_JSON");
    }
    throw error;
  }
}

export async function readJsonStrict(
  path,
  { maxBytes = MAX_JSON_BYTES, maxDepth = MAX_JSON_DEPTH, maxNodes = MAX_JSON_NODES } = {},
) {
  let handle;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    if (["ELOOP", "EFTYPE", "ENXIO"].includes(error?.code)) {
      throw new ContractError(`${path}: unsafe JSON input`, "INVALID_JSON");
    }
    throw error;
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      throw new ContractError(`${path}: JSON input must be a regular file`, "INVALID_JSON");
    }
    if (before.size > BigInt(maxBytes)) {
      throw new ContractError(`${path}: input exceeds ${maxBytes} byte limit`, "INVALID_JSON");
    }
    const expectedSize = Number(before.size);
    const bytes = Buffer.alloc(expectedSize + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      offset !== expectedSize ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs
    ) {
      throw new ContractError(`${path}: JSON input changed while read`, "INVALID_JSON");
    }
    return parseJsonStrict(decodeUtf8Strict(bytes.subarray(0, offset), path, maxBytes), path, {
      maxBytes,
      maxDepth,
      maxNodes,
    });
  } finally {
    await handle.close();
  }
}

export function prettyJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
