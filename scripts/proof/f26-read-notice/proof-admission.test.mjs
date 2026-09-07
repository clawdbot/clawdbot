import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createDecipheriv, generateKeyPairSync, privateDecrypt } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readCommand } from "./command-read.mjs";
import { exportEvidenceArchive } from "./evidence-archive.mjs";
import { admitProof } from "./proof-admission.mjs";

const identity = {
  baseline: "synthetic-source",
  harness: "synthetic-harness",
  run: "synthetic-run",
  attempt: "1",
};
const exportIdentity = {
  source: identity.baseline,
  harness: identity.harness,
  run: identity.run,
  attempt: identity.attempt,
};
function evidenceRoot() {
  return path.join(mkdtempSync(path.join(tmpdir(), "f26-admission-")), "evidence");
}
async function exported(root) {
  const preflight = JSON.parse(readFileSync(path.join(root, "public/preflight.json"), "utf8"));
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await exportEvidenceArchive({
    root,
    preflight,
    identity: exportIdentity,
    recipient: keys.publicKey.export({ type: "spki", format: "pem" }),
    exportDeadline: Date.now() + 600000,
  });
  const envelope = JSON.parse(readFileSync(path.join(root, "encrypted/envelope.json"), "utf8"));
  const key = privateDecrypt(
    { key: keys.privateKey, oaepHash: "sha256" },
    Buffer.from(envelope.wrappedKey, "base64"),
  );
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.nonce, "base64"));
  decipher.setAAD(Buffer.from(envelope.aad));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const archive = path.join(root, "verified.tgz");
  writeFileSync(
    archive,
    Buffer.concat([
      decipher.update(readFileSync(path.join(root, "encrypted/evidence.bin"))),
      decipher.final(),
    ]),
  );
  key.fill(0);
  return (file) => execFileSync("tar", ["-xOzf", archive, file], { encoding: "utf8" });
}

test("a below-limit admission writes its exact refused sample before exporting it without compilation", async () => {
  const root = evidenceRoot();
  const sample = {
    memory: 8 * 1024 ** 3,
    freeMemory: 1024 ** 3,
    runnerUserRSS: 1024 ** 3,
    freeDisk: 32 * 1024 ** 3,
    raw: {
      physicalMemory: "8589934592",
      vmStat: "synthetic low-free sample",
      processes: "synthetic process table",
    },
  };
  assert.throws(
    () =>
      admitProof({
        root,
        identity,
        redact: (text) => text,
        verifySource: () => ({ actualSource: identity.baseline }),
        measure: () => sample,
      }),
    /2 GiB free-plus-inactive/,
  );
  assert.equal(existsSync(path.join(root, "private")), true);
  const read = await exported(root);
  const receipt = JSON.parse(read("public/preflight.json"));
  assert.equal(receipt.state, "refused");
  assert.equal(receipt.stage, "admission");
  assert.deepEqual(receipt.measurement, sample);
  assert.deepEqual(receipt.conditions, {
    physicalMemory: true,
    freeMemory: false,
    runnerResidentMemory: true,
    disk: true,
  });
  assert.equal(
    JSON.parse(readFileSync(path.join(root, "encrypted/export-status.json"), "utf8"))
      .nativeAppArchiveComplete,
    false,
  );
});

test("a real output-producing query failure retains partial redacted evidence and refused state in the encrypted archive", async () => {
  const root = evidenceRoot();
  const redact = (text) => text.replaceAll("synthetic-private-marker", "[REDACTED]");
  assert.throws(
    () =>
      admitProof({
        root,
        identity,
        redact,
        verifySource: () => ({ actualSource: identity.baseline }),
        measure: (record) =>
          readCommand(
            process.execPath,
            [
              "-e",
              'process.stdout.write("partial synthetic-private-marker\\n"); process.stderr.write("query diagnostic\\n"); process.exitCode=7;',
            ],
            record,
          ),
      }),
    (error) => error.status === 7,
  );
  const read = await exported(root);
  const receipt = JSON.parse(read("public/preflight.json"));
  assert.equal(receipt.state, "refused");
  assert.equal(receipt.stage, "measurement");
  assert.equal(Object.hasOwn(receipt, "measurement"), false);
  const lines = read("public/phase.jsonl").trim().split("\n").map(JSON.parse);
  const query = lines.find((line) => line.event === "command-read-failed");
  assert.equal(query.stdout, "partial [REDACTED]\n");
  assert.equal(query.stderr, "query diagnostic\n");
  assert.equal(query.status, 7);
  assert.equal(query.signal, null);
  assert.equal(query.complete, false);
  assert.equal(lines.at(-1).event, "admission-refused");
  assert.equal(read("public/phase.jsonl").includes("synthetic-private-marker"), false);
});

test("the original admission boundaries still accept a fitting sample", () => {
  const root = evidenceRoot();
  const result = admitProof({
    root,
    identity,
    redact: (text) => text,
    verifySource: () => ({ actualSource: identity.baseline }),
    measure: () => ({
      memory: 6 * 1024 ** 3,
      freeMemory: 2 * 1024 ** 3,
      runnerUserRSS: 5 * 1024 ** 3 - 1,
      freeDisk: 24 * 1024 ** 3,
    }),
  });
  assert.equal(result.preflight.state, "admitted");
  assert.deepEqual(result.preflight.conditions, {
    physicalMemory: true,
    freeMemory: true,
    runnerResidentMemory: true,
    disk: true,
  });
});

test("source refusal retains evidence and never invokes host admission", () => {
  const root = evidenceRoot();
  let measured = false;
  assert.throws(
    () =>
      admitProof({
        root,
        identity,
        redact: (text) => text,
        verifySource: () => {
          throw new Error("Synthetic source mismatch");
        },
        measure: () => {
          measured = true;
          throw new Error("Must not measure unverified source");
        },
      }),
    /Synthetic source mismatch/,
  );
  assert.equal(measured, false);
  const receipt = JSON.parse(readFileSync(path.join(root, "public/preflight.json"), "utf8"));
  assert.equal(receipt.state, "refused");
  assert.equal(receipt.stage, "source");
  assert.equal(receipt.sourceVerified, false);
});
