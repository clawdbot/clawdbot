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

export async function exportEvidenceArchive({
  root,
  recipient,
  identity,
  preflight,
  exportDeadline,
  productsDirectory,
}) {
  const output = path.join(root, "encrypted");
  assert(!existsSync(output), "Preserve any earlier export result");
  mkdirSync(output, { mode: 0o700 });
  const key = randomBytes(32);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const aad = JSON.stringify(identity);
  cipher.setAAD(Buffer.from(aad));
  const archive = spawn(
    "tar",
    [
      "-czf",
      "-",
      "-C",
      root,
      "public",
      "private",
      ...(productsDirectory ? ["-C", path.dirname(productsDirectory), "Products"] : []),
    ],
    {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
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
    Math.max(0, exportDeadline - Date.now()),
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
      JSON.stringify({
        complete: true,
        archiveComplete: true,
        preflightState: preflight.state,
        buildProductsArchiveComplete: Boolean(productsDirectory),
        nativeAppArchivePresent: existsSync(path.join(root, "private/native-app.tgz")),
        nativeAppArchiveComplete:
          existsSync(path.join(root, "public/app-archive.json")) &&
          JSON.parse(readFileSync(path.join(root, "public/app-archive.json"), "utf8")).complete ===
            true,
        ...result,
        stderr,
      }),
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
    throw error;
  } finally {
    clearTimeout(timer);
    key.fill(0);
  }
}
