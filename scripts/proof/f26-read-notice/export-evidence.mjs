import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createCipheriv, createHash, publicEncrypt, randomBytes } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

assert.equal(process.platform, "darwin");
assert.equal(process.env.GITHUB_ACTIONS, "true");
const input = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(process.cwd(), "apps/ios/build/F26Evidence");
const output = path.join(root, "encrypted");
assert(existsSync(path.join(root, "public")) && !existsSync(output));
const recipient = readFileSync(path.join(input, "artifact-recipient.pem"));
assert.equal(
  createHash("sha256").update(recipient).digest("hex"),
  "21b9a6b9c2b5ba1a6cf0f823571707cb5f2adbcd8fdfabc1409812e0d429e7ca",
);
mkdirSync(output, { mode: 0o700 });
const key = randomBytes(32);
const nonce = randomBytes(12);
const cipher = createCipheriv("aes-256-gcm", key, nonce);
const aad = JSON.stringify({
  source: process.env.F26_TARGET_SHA,
  run: process.env.GITHUB_RUN_ID,
  attempt: process.env.GITHUB_RUN_ATTEMPT,
  harness: process.env.GITHUB_WORKFLOW_SHA,
});
cipher.setAAD(Buffer.from(aad));
const archive = spawn("tar", ["-czf", "-", "-C", root, "public", "private"], {
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
archive.stderr.on("data", (bytes) => {
  stderr += bytes;
});
const joined = new Promise((resolve, reject) => {
  archive.once("error", reject);
  archive.once("close", (code, signal) => resolve({ code, signal }));
});
const abort = new AbortController();
const timer = setTimeout(
  () => abort.abort(new Error("10-minute evidence export deadline")),
  600000,
);
let bytesWritten = 0;
const hash = createHash("sha256");
const limit = new Transform({
  transform(bytes, encoding, callback) {
    bytesWritten += bytes.length;
    const disk = statfsSync(root);
    if (bytesWritten > 4 * 1024 ** 3 || disk.bavail * disk.bsize < 1024 ** 3) {
      callback(new Error("Export size/free-space safeguard"));
      return;
    }
    hash.update(bytes);
    callback(null, bytes);
  },
});
try {
  await pipeline(
    archive.stdout,
    cipher,
    limit,
    createWriteStream(path.join(output, "evidence.bin"), { flags: "wx", mode: 0o600 }),
    { signal: abort.signal },
  );
  const result = await joined;
  assert.equal(result.code, 0, "Evidence archive failed");
  const envelope = {
    version: 1,
    cipher: "aes-256-gcm",
    keyWrap: "rsa-oaep-sha256",
    wrappedKey: publicEncrypt({ key: recipient, oaepHash: "sha256" }, key).toString("base64"),
    nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    aad,
    sha256: hash.digest("hex"),
    bytes: bytesWritten,
  };
  writeFileSync(path.join(output, "envelope.json"), JSON.stringify(envelope, null, 2) + "\n");
  writeFileSync(
    path.join(output, "export-status.json"),
    JSON.stringify({ complete: true, ...result, stderr }),
  );
} catch (error) {
  try {
    process.kill(-archive.pid, "SIGTERM");
  } catch {}
  const killTimer = setTimeout(() => {
    try {
      process.kill(-archive.pid, "SIGKILL");
    } catch {}
  }, 10000);
  const result = await joined;
  clearTimeout(killTimer);
  writeFileSync(
    path.join(output, "export-status.json"),
    JSON.stringify({ complete: false, error: String(error), ...result, bytesWritten }),
  );
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  key.fill(0);
}
