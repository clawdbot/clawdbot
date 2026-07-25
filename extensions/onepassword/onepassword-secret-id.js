const ENCODED_SECRET_ID_PREFIX = "opb64:";
const MAX_NATIVE_SECRET_ID_BYTES = 2048;
const EXEC_SECRET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,255}$/;

function invalidSecretId(message) {
  return new Error(`Invalid 1Password SecretRef id: ${message}`);
}

function assertSafeNativeSecretId(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw invalidSecretId("the value is empty.");
  }
  if (Buffer.byteLength(value, "utf8") > MAX_NATIVE_SECRET_ID_BYTES) {
    throw invalidSecretId(`the value exceeds ${MAX_NATIVE_SECRET_ID_BYTES} bytes.`);
  }
  if (value.trim() !== value || value.startsWith("/") || value.includes("\\")) {
    throw invalidSecretId(
      "leading/trailing whitespace, absolute paths, and backslashes are not allowed.",
    );
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) {
      throw invalidSecretId("only printable ASCII characters are allowed.");
    }
  }
  if (value.split("/").some((segment) => segment === "." || segment === "..")) {
    throw invalidSecretId('"." and ".." path segments are not allowed.');
  }
}

function isCanonicalExecSecretId(value) {
  return (
    EXEC_SECRET_ID_PATTERN.test(value) &&
    !value.split("/").some((segment) => segment === "." || segment === "..")
  );
}

function assertReferenceShape(value) {
  const native = value.startsWith("op://") ? value.slice("op://".length) : value;
  const pathOnly = native.split("?", 1)[0];
  const parts = pathOnly.split("/");
  const expectedPartCount = [3, 4];
  if (!expectedPartCount.includes(parts.length) || parts.some((part) => part.length === 0)) {
    throw invalidSecretId(
      'use "op://<vault>/<item>/<field>", "<vault>/<item>/<field>", or "<vault>/<item>/<section>/<field>".',
    );
  }
}

export function encodeOnePasswordSecretId(value) {
  assertSafeNativeSecretId(value);
  assertReferenceShape(value);
  if (isCanonicalExecSecretId(value) && !value.startsWith(ENCODED_SECRET_ID_PREFIX)) {
    return value;
  }
  const encoded = `${ENCODED_SECRET_ID_PREFIX}${Buffer.from(value, "utf8").toString("base64url")}`;
  if (!isCanonicalExecSecretId(encoded)) {
    throw invalidSecretId(
      "the encoded reference exceeds OpenClaw's exec SecretRef limit; use 1Password vault, item, section, and field IDs to shorten it.",
    );
  }
  return encoded;
}

export function decodeOnePasswordSecretId(value) {
  if (!value.startsWith(ENCODED_SECRET_ID_PREFIX)) {
    return value;
  }
  const payload = value.slice(ENCODED_SECRET_ID_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) {
    throw invalidSecretId("the encoded reference is malformed.");
  }
  const decoded = Buffer.from(payload, "base64url").toString("utf8");
  if (Buffer.from(decoded, "utf8").toString("base64url") !== payload) {
    throw invalidSecretId("the encoded reference is malformed.");
  }
  assertSafeNativeSecretId(decoded);
  return decoded;
}

export function resolveOnePasswordSecretReference(value) {
  const decoded = decodeOnePasswordSecretId(value);
  assertSafeNativeSecretId(decoded);
  assertReferenceShape(decoded);
  if (decoded.startsWith("op://")) {
    return decoded;
  }
  return `op://${decoded}`;
}
