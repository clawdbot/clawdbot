import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import {
  GUARDED_REPLACE_FAILURE_CODE,
  hashGuardedPluginPayload,
  installGuardedReplace,
  installGuardedReplaceReconcile,
  type GuardedReplaceFault,
} from "../infra/install-guarded-replace.js";
import {
  loadInstalledPluginIndexInstallRecords,
  writePersistedInstalledPluginIndexInstallRecords,
} from "../plugins/installed-plugin-index-records.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";

const tempDirs: string[] = [];

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function files(version: string, marker: string) {
  return {
    "package.json": JSON.stringify({
      name: "demo",
      version,
      type: "module",
      openclaw: { extensions: ["./index.js"] },
    }),
    "openclaw.plugin.json": JSON.stringify({
      id: "demo",
      configSchema: { type: "object", additionalProperties: false },
    }),
    "index.js": `export default ${JSON.stringify(marker)};\n`,
  };
}

async function writeTree(root: string, entries: Record<string, string>) {
  await fs.mkdir(root, { recursive: true });
  await Promise.all(
    Object.entries(entries).map(([name, content]) => fs.writeFile(path.join(root, name), content)),
  );
}

async function zipArchive(filePath: string, entries: Record<string, string>) {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(entries)) {
    zip.file(name, content);
  }
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await fs.writeFile(filePath, bytes);
  return createHash("sha256").update(bytes).digest("hex");
}

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-guarded-reconcile-"));
  tempDirs.push(root);
  const configDir = path.join(root, "config");
  const extensionsDir = path.join(configDir, "extensions");
  const targetDir = path.join(extensionsDir, "demo");
  const stateDir = path.join(root, "state-dir");
  const receiptDir = path.join(root, "receipts");
  const predecessor = files("1.0.0", "predecessor");
  await writeTree(targetDir, predecessor);
  await fs.mkdir(receiptDir, { recursive: true });
  const candidateArchive = path.join(root, "candidate.zip");
  const rollbackArchive = path.join(root, "rollback.zip");
  const candidateSha256 = await zipArchive(candidateArchive, files("2.0.0", "candidate"));
  const rollbackSha256 = await zipArchive(rollbackArchive, predecessor);
  const predecessorSha256 = await hashGuardedPluginPayload(targetDir);
  const env = {
    ...process.env,
    OPENCLAW_CONFIG_DIR: configDir,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_VERSION: "2026.8.4",
    VITEST: "true",
  };
  await writePersistedInstalledPluginIndexInstallRecords(
    {
      demo: {
        source: "archive",
        sourcePath: rollbackArchive,
        installPath: targetDir,
        version: "1.0.0",
        installedAt: "2026-08-04T00:00:00.000Z",
      },
    },
    { stateDir, env, config: {} },
  );
  let nextId = 0;
  const receiptPath = path.join(receiptDir, "replace.json");
  const base = {
    candidateArchive,
    candidateSha256,
    expectedPredecessorSha256: predecessorSha256,
    pluginId: "demo",
    receiptPath,
    rollbackArchive,
    rollbackSha256,
    config: {},
    extensionsDir,
    stateDir,
    env,
    now: () => 1_775_520_000_000,
    createId: () => `00000000-0000-7000-8000-${String(++nextId).padStart(12, "0")}`,
  };
  return { root, targetDir, predecessorSha256, receiptPath, base };
}

async function interruptAt(fault: GuardedReplaceFault) {
  const fixture = await createFixture();
  await expect(installGuardedReplace({ ...fixture.base, fault })).rejects.toMatchObject({
    code: GUARDED_REPLACE_FAILURE_CODE.FAULT_INJECTED,
  });
  return fixture;
}

async function reconcile(fixture: Awaited<ReturnType<typeof createFixture>>) {
  return await installGuardedReplaceReconcile({
    receiptPath: fixture.receiptPath,
    extensionsDir: fixture.base.extensionsDir,
    stateDir: fixture.base.stateDir,
    env: fixture.base.env,
    config: {},
    now: fixture.base.now,
  });
}

describe("plugins replace-guarded reconcile", () => {
  it("aborts an interruption before swap without mutating target or index", async () => {
    const fixture = await interruptAt("before-swap");
    expect(await hashGuardedPluginPayload(fixture.targetDir)).toBe(fixture.predecessorSha256);

    const receipt = await reconcile(fixture);
    expect(receipt.outcome).toBe("ABORTED");
    expect(await hashGuardedPluginPayload(fixture.targetDir)).toBe(fixture.predecessorSha256);
    const records = await loadInstalledPluginIndexInstallRecords({
      stateDir: fixture.base.stateDir,
      env: fixture.base.env,
    });
    expect(records.demo?.version).toBe("1.0.0");
  });

  it("restores the predecessor when swap published before the index transaction", async () => {
    const fixture = await interruptAt("after-swap");
    expect(await fs.readFile(path.join(fixture.targetDir, "index.js"), "utf8")).toContain(
      "candidate",
    );

    const receipt = await reconcile(fixture);
    expect(receipt.outcome).toBe("ROLLED_BACK");
    expect(await hashGuardedPluginPayload(fixture.targetDir)).toBe(fixture.predecessorSha256);
    await expect(reconcile(fixture)).resolves.toEqual(receipt);
  });

  it("finalizes the receipt when target and index committed before receipt finalization", async () => {
    const fixture = await interruptAt("after-state-finalize");
    const recordsBefore = await loadInstalledPluginIndexInstallRecords({
      stateDir: fixture.base.stateDir,
      env: fixture.base.env,
    });
    expect(recordsBefore.demo?.version).toBe("2.0.0");

    const receipt = await reconcile(fixture);
    expect(receipt.outcome).toBe("SUCCESS");
    expect(await fs.readFile(path.join(fixture.targetDir, "index.js"), "utf8")).toContain(
      "candidate",
    );
    await expect(fs.access(receipt.transactionRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(reconcile(fixture)).resolves.toEqual(receipt);
  });

  it("rejects a receipt whose candidate record hash was rewritten to the predecessor hash", async () => {
    const fixture = await interruptAt("after-swap");
    const receipt = JSON.parse(await fs.readFile(fixture.receiptPath, "utf8")) as {
      installedIndex: { previousRecordSha256: string; candidateRecordSha256: string };
      predecessor: { capturedBackup: string };
    };
    receipt.installedIndex.candidateRecordSha256 = receipt.installedIndex.previousRecordSha256;
    await fs.writeFile(fixture.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

    await expect(reconcile(fixture)).rejects.toMatchObject({
      code: GUARDED_REPLACE_FAILURE_CODE.RECOVERY_INCOMPLETE,
    });
    expect(await fs.readFile(path.join(fixture.targetDir, "index.js"), "utf8")).toContain(
      "candidate",
    );
    await expect(fs.access(receipt.predecessor.capturedBackup)).resolves.toBeUndefined();
  });

  it("fails closed when a claimed captured predecessor is missing", async () => {
    const fixture = await interruptAt("after-swap");
    const interrupted = JSON.parse(await fs.readFile(fixture.receiptPath, "utf8")) as {
      predecessor: { capturedBackup: string };
    };
    await fs.rm(interrupted.predecessor.capturedBackup, { recursive: true, force: true });

    const receipt = await reconcile(fixture);
    expect(receipt.outcome).toBe("INCOMPLETE");
    expect(receipt.recovery_status).toBe("REQUIRES_OPERATOR");
    expect(receipt.failure_code).toBe(GUARDED_REPLACE_FAILURE_CODE.RECOVERY_INCOMPLETE);
  });

  it("rejects a symlinked candidate target that escapes the extensions directory", async () => {
    const fixture = await interruptAt("after-state-finalize");
    const externalCandidate = path.join(fixture.root, "external-candidate");
    await writeTree(externalCandidate, files("2.0.0", "candidate"));
    await fs.rm(fixture.targetDir, { recursive: true, force: true });
    await fs.symlink(externalCandidate, fixture.targetDir, "dir");

    await expect(reconcile(fixture)).rejects.toMatchObject({
      code: GUARDED_REPLACE_FAILURE_CODE.INVALID_INPUT,
    });
    expect((await fs.lstat(fixture.targetDir)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(externalCandidate, "index.js"), "utf8")).toContain(
      "candidate",
    );
  });

  it("rejects a symlinked predecessor backup before mutating the candidate target", async () => {
    const fixture = await interruptAt("after-swap");
    const interrupted = JSON.parse(await fs.readFile(fixture.receiptPath, "utf8")) as {
      predecessor: { capturedBackup: string };
    };
    const externalPredecessor = path.join(fixture.root, "external-predecessor");
    await writeTree(externalPredecessor, files("1.0.0", "predecessor"));
    await fs.rm(interrupted.predecessor.capturedBackup, { recursive: true, force: true });
    await fs.symlink(externalPredecessor, interrupted.predecessor.capturedBackup, "dir");

    await expect(reconcile(fixture)).rejects.toMatchObject({
      code: GUARDED_REPLACE_FAILURE_CODE.GUARD_FAILED,
    });
    expect(await fs.readFile(path.join(fixture.targetDir, "index.js"), "utf8")).toContain(
      "candidate",
    );
    expect((await fs.lstat(interrupted.predecessor.capturedBackup)).isSymbolicLink()).toBe(true);
  });
});
