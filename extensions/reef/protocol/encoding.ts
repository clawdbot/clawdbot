const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function utf8(value: string): Uint8Array {
  return encoder.encode(value);
}

export function decodeUtf8(value: Uint8Array): string {
  return decoder.decode(value);
}

export function base64url(value: Uint8Array): string {
  let output = "";
  for (let index = 0; index < value.length; index += 3) {
    const a = value[index] ?? 0;
    const b = value[index + 1] ?? 0;
    const c = value[index + 2] ?? 0;
    const bits = (a << 16) | (b << 8) | c;
    output += alphabet[(bits >>> 18) & 63];
    output += alphabet[(bits >>> 12) & 63];
    if (index + 1 < value.length) {
      output += alphabet[(bits >>> 6) & 63];
    }
    if (index + 2 < value.length) {
      output += alphabet[bits & 63];
    }
  }
  return output;
}

export function fromBase64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) {
    throw new Error("invalid base64url");
  }
  const output = new Uint8Array(Math.floor((value.length * 6) / 8));
  let bits = 0;
  let count = 0;
  let offset = 0;
  for (const character of value) {
    const digit = alphabet.indexOf(character);
    bits = (bits << 6) | digit;
    count += 6;
    if (count >= 8) {
      count -= 8;
      output[offset++] = (bits >>> count) & 0xff;
    }
  }
  if (count > 0 && (bits & ((1 << count) - 1)) !== 0) {
    throw new Error("invalid base64url padding");
  }
  return output;
}

export function base64(value: Uint8Array): string {
  let output = "";
  for (let index = 0; index < value.length; index += 3) {
    const a = value[index] ?? 0;
    const b = value[index + 1] ?? 0;
    const c = value[index + 2] ?? 0;
    const bits = (a << 16) | (b << 8) | c;
    output += base64Alphabet[(bits >>> 18) & 63];
    output += base64Alphabet[(bits >>> 12) & 63];
    output += index + 1 < value.length ? base64Alphabet[(bits >>> 6) & 63] : "=";
    output += index + 2 < value.length ? base64Alphabet[bits & 63] : "=";
  }
  return output;
}

export function fromBase64(value: string): Uint8Array {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error("invalid base64");
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const output = new Uint8Array((value.length / 4) * 3 - padding);
  let offset = 0;
  for (let index = 0; index < value.length; index += 4) {
    const digits = [value[index]!, value[index + 1]!, value[index + 2]!, value[index + 3]!].map(
      (character) => (character === "=" ? 0 : base64Alphabet.indexOf(character)),
    );
    const bits = (digits[0]! << 18) | (digits[1]! << 12) | (digits[2]! << 6) | digits[3]!;
    if (offset < output.length) {
      output[offset++] = (bits >>> 16) & 0xff;
    }
    if (offset < output.length) {
      output[offset++] = (bits >>> 8) & 0xff;
    }
    if (offset < output.length) {
      output[offset++] = bits & 0xff;
    }
  }
  if (base64(output) !== value) {
    throw new Error("non-canonical base64");
  }
  return output;
}

export function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < a.length; index++) {
    difference |= a[index]! ^ b[index]!;
  }
  return difference === 0;
}
