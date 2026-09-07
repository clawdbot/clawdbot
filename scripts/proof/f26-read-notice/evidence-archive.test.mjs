import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createDecipheriv, createHash, generateKeyPairSync, privateDecrypt } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { exportEvidenceArchive } from "./evidence-archive.mjs";

test("an initialized admission refusal exports complete encrypted diagnostics without an app archive", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "f26-refusal-export-"));
  mkdirSync(path.join(root, "public"));
  mkdirSync(path.join(root, "private"));
  const identity = {
    source: "synthetic-source",
    harness: "synthetic-harness",
    run: "synthetic-run",
    attempt: "1",
  };
  const preflight = {
    baseline: identity.source,
    harness: identity.harness,
    run: identity.run,
    attempt: identity.attempt,
    state: "refused",
    stage: "measurement",
    sourceVerified: true,
    error: "Synthetic failed query; no complete admission sample",
  };
  const query = {
    event: "command-read-failed",
    command: "synthetic-query",
    args: [],
    complete: false,
    stdout: "partial process table\n",
    stderr: "query failed\n",
    status: 7,
    signal: null,
  };
  writeFileSync(path.join(root, "public/preflight.json"), JSON.stringify(preflight) + "\n");
  writeFileSync(path.join(root, "public/phase.jsonl"), JSON.stringify(query) + "\n");
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const recipient = keys.publicKey.export({ type: "spki", format: "pem" });
  await exportEvidenceArchive({
    root,
    recipient,
    identity,
    preflight,
    exportDeadline: Date.now() + 600000,
  });
  const output = path.join(root, "encrypted");
  const status = JSON.parse(readFileSync(path.join(output, "export-status.json"), "utf8"));
  assert.equal(status.archiveComplete, true);
  assert.equal(status.preflightState, "refused");
  assert.equal(status.nativeAppArchivePresent, false);
  assert.equal(status.nativeAppArchiveComplete, false);
  const envelope = JSON.parse(readFileSync(path.join(output, "envelope.json"), "utf8"));
  const encrypted = readFileSync(path.join(output, "evidence.bin"));
  assert.equal(createHash("sha256").update(encrypted).digest("hex"), envelope.sha256);
  assert.equal(encrypted.length, envelope.bytes);
  assert.deepEqual(JSON.parse(envelope.aad), identity);
  const key = privateDecrypt(
    { key: keys.privateKey, oaepHash: "sha256" },
    Buffer.from(envelope.wrappedKey, "base64"),
  );
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.nonce, "base64"));
  decipher.setAAD(Buffer.from(envelope.aad));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const archive = path.join(root, "verified-refusal.tgz");
  writeFileSync(archive, Buffer.concat([decipher.update(encrypted), decipher.final()]));
  key.fill(0);
  const retainedPreflight = execFileSync("tar", ["-xOzf", archive, "public/preflight.json"], {
    encoding: "utf8",
  });
  const retainedQuery = execFileSync("tar", ["-xOzf", archive, "public/phase.jsonl"], {
    encoding: "utf8",
  });
  assert.deepEqual(JSON.parse(retainedPreflight), preflight);
  assert.deepEqual(JSON.parse(retainedQuery), query);
});
