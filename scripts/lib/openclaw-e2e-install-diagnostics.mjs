import fs from "node:fs";
const prefix = "[release typed onboarding install] ";
const omitted = `${prefix}[diagnostics omitted]\n`;
function requireInvariant(value) {
  if (!value) {
    throw new Error();
  }
}
function readLimit(name, fallback) {
  const value = process.env[name] ?? String(fallback);
  const number = Number(value);
  requireInvariant(/^\d+$/u.test(value) && Number.isSafeInteger(number));
  return number;
}
function validSidecar(stat, uid) {
  return (
    Number.isSafeInteger(uid) &&
    uid >= 0 &&
    stat.isFile() &&
    stat.nlink === 1 &&
    stat.uid === uid &&
    (stat.mode & 0o777) === 0o622
  );
}
function sameIdentity(left, right) {
  return ["dev", "ino", "uid", "nlink", "mode"].every((key) => left[key] === right[key]);
}
function useSidecar(file, flags, operation) {
  const uid = Number(process.env.OPENCLAW_E2E_INSTALL_DIAGNOSTICS_UID ?? process.getuid?.());
  const before = fs.lstatSync(file);
  requireInvariant(validSidecar(before, uid));
  const fd = fs.openSync(file, flags | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(fd);
    requireInvariant(validSidecar(opened, uid) && sameIdentity(before, opened));
    const result = operation(fd, before);
    const after = fs.fstatSync(fd);
    requireInvariant(
      validSidecar(after, uid) &&
        sameIdentity(before, after) &&
        after.size === result.size &&
        (!result.unchanged ||
          (before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs)),
    );
    return result.value;
  } finally {
    fs.closeSync(fd);
  }
}
function writeSidecar(file, bytes) {
  useSidecar(file, fs.constants.O_WRONLY, (fd) => {
    fs.ftruncateSync(fd, 0);
    requireInvariant(
      bytes.length === 0 || fs.writeSync(fd, bytes, 0, bytes.length, 0) === bytes.length,
    );
    return { size: bytes.length };
  });
}
async function capture(file) {
  const maxBytes = readLimit("OPENCLAW_E2E_LOG_TAIL_BYTES", 262144);
  const maxLines = readLimit("OPENCLAW_E2E_LOG_TAIL_LINES", 120);
  let tail = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    tail = Buffer.concat([tail, chunk]);
    if (tail.length > maxBytes) {
      tail = tail.subarray(tail.length - maxBytes);
    }
  }
  const text = tail.toString("utf8");
  const trailingNewline = text.endsWith("\n");
  const lines = text.split("\n");
  if (trailingNewline) {
    lines.pop();
  }
  const bounded = maxLines ? lines.slice(-maxLines).join("\n") + (trailingNewline ? "\n" : "") : "";
  writeSidecar(file, Buffer.from(bounded));
}
function readSidecar(file) {
  return useSidecar(file, fs.constants.O_RDONLY, (fd, before) => {
    const limit = readLimit("OPENCLAW_E2E_LOG_TAIL_BYTES", 262144);
    requireInvariant(before.size > 0 && before.size <= limit);
    const bytes = fs.readFileSync(fd);
    requireInvariant(bytes.length === before.size);
    return { size: before.size, unchanged: true, value: bytes.toString("utf8") };
  });
}
function stripFraming(text) {
  return (
    text
      // eslint-disable-next-line no-control-regex -- Match ANSI framing bytes explicitly.
      .replace(/\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/gu, "")
      .replaceAll("\r\n", "\n")
      .replaceAll("\r", "\n")
      // eslint-disable-next-line no-control-regex -- Remove non-printing control bytes from logs.
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "")
  );
}
function formatInstallDiagnostics(file, redactSensitiveText) {
  try {
    const redacted = redactSensitiveText(stripFraming(readSidecar(file)), { mode: "tools" });
    requireInvariant(typeof redacted === "string");
    const safe = stripFraming(redacted);
    const lines = safe.endsWith("\n") ? safe.slice(0, -1).split("\n") : safe.split("\n");
    requireInvariant(lines.some((line) => line.length > 0));
    return `${lines.map((line) => `${prefix}${line}`).join("\n")}\n`;
  } catch {
    return omitted;
  }
}
async function main() {
  const [mode, file] = process.argv.slice(2);
  if (mode === "capture") {
    await capture(file);
  } else if (mode === "clear") {
    writeSidecar(file, Buffer.alloc(0));
  } else if (mode === "publish") {
    const { redactSensitiveText } = await import("../../src/logging/redact.ts");
    process.stdout.write(formatInstallDiagnostics(file, redactSensitiveText));
  } else {
    throw new Error();
  }
}
if (process.argv[1]?.replaceAll("\\", "/").endsWith("/openclaw-e2e-install-diagnostics.mjs")) {
  main().catch(() => {
    process.exitCode = 74;
  });
}
