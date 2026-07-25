// Covers config journal snapshot fingerprints, slot ownership, and restoration.
import fs from "node:fs";
import { promises as fsPromises } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import {
  fingerprintConfigSnapshotAuthoredConfig,
  readConfigSnapshotAuditRecord,
  readLatestConfigSnapshotAuditRecord,
  restoreConfigSnapshotAuditRecord,
  upsertConfigSnapshotAuditRecord,
} from "./config-journal-snapshot.js";

describe("config journal snapshots", () => {
  const suiteRootTracker = createSuiteTempRootTracker({
    prefix: "openclaw-config-journal-snapshot-",
  });

  beforeAll(async () => {
    await suiteRootTracker.setup();
  });

  it("fingerprints every snapshot leaf with a per-install key", async () => {
    const home = await suiteRootTracker.make("fingerprint-home");
    const stateDir = path.join(home, ".openclaw");
    const fingerprinted = fingerprintConfigSnapshotAuthoredConfig(
      {
        gateway: { auth: { token: "test-token" }, port: 18789 },
      },
      {
        env: { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv,
        homedir: () => home,
      },
    );

    expect(fingerprinted).toMatchObject({
      gateway: {
        auth: { token: expect.stringMatching(/^fp:[0-9a-f]{12}$/) },
        port: expect.stringMatching(/^fp:[0-9a-f]{12}$/),
      },
    });
    expect(JSON.stringify(fingerprinted)).not.toContain("test-token");
    expect(fs.statSync(path.join(stateDir, "config-journal-fingerprint.key")).mode & 0o777).toBe(
      0o600,
    );

    // Type-only edits must change the fingerprint: "1" vs 1 vs true vs "true".
    const context = {
      env: { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv,
      homedir: () => home,
    };
    const fingerprintOf = (value: unknown) =>
      (fingerprintConfigSnapshotAuthoredConfig({ leaf: value }, context) as { leaf: string }).leaf;
    const variants = [
      fingerprintOf("1"),
      fingerprintOf(1),
      fingerprintOf(true),
      fingerprintOf("true"),
    ];
    expect(new Set(variants).size).toBe(variants.length);
    expect(fingerprintOf("1")).toBe(fingerprintOf("1"));
  });

  it("hands the snapshot slot to another config path via the unfiltered CAS token", async () => {
    const home = await suiteRootTracker.make("snapshot-path-transfer");
    const env = { OPENCLAW_STATE_DIR: path.join(home, ".openclaw") } as NodeJS.ProcessEnv;
    const context = { env, homedir: () => home };
    const pathA = path.join(home, ".openclaw", "config-a.json");
    const pathB = path.join(home, ".openclaw", "config-b.json");
    upsertConfigSnapshotAuditRecord({
      ...context,
      configPath: pathA,
      rawHash: "path-a-hash",
      authoredConfig: { gateway: { port: 1 } },
    });
    // Path-filtered read for B sees nothing, but the unfiltered slot is the
    // CAS token that lets B take the slot over from A.
    expect(readConfigSnapshotAuditRecord({ ...context, configPath: pathB })).toBeNull();
    const foreign = readLatestConfigSnapshotAuditRecord(context);
    expect(foreign?.configPath).toBe(path.resolve(pathA));
    const taken = upsertConfigSnapshotAuditRecord({
      ...context,
      configPath: pathB,
      rawHash: "path-b-hash",
      authoredConfig: { gateway: { port: 2 } },
      expectedSnapshot: foreign,
    });
    expect(taken?.configPath).toBe(path.resolve(pathB));
    expect(readConfigSnapshotAuditRecord({ ...context, configPath: pathB })?.rawHash).toBe(
      "path-b-hash",
    );
  });

  it("does not restore a snapshot slot after another writer replaces it", async () => {
    const home = await suiteRootTracker.make("snapshot-compare-and-set");
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const env = { OPENCLAW_STATE_DIR: path.join(home, ".openclaw") } as NodeJS.ProcessEnv;
    const context = { env, homedir: () => home };
    const prior = upsertConfigSnapshotAuditRecord({
      ...context,
      configPath,
      rawHash: "prior",
      authoredConfig: { gateway: { port: 18789 } },
    });
    const written = upsertConfigSnapshotAuditRecord({
      ...context,
      configPath,
      rawHash: "written",
      authoredConfig: { gateway: { port: 18790 } },
    });
    upsertConfigSnapshotAuditRecord({
      ...context,
      configPath,
      rawHash: "newer-process",
      authoredConfig: { gateway: { port: 18791 } },
    });

    restoreConfigSnapshotAuditRecord({
      ...context,
      snapshot: prior,
      expectedSnapshot: written,
    });

    expect(readConfigSnapshotAuditRecord({ ...context, configPath })).toMatchObject({
      rawHash: "newer-process",
    });
  });

  it("falls back to a redaction marker when the fingerprint key cannot be stored", async () => {
    const home = await suiteRootTracker.make("fingerprint-fallback");
    const statePath = path.join(home, "state-file");
    await fsPromises.writeFile(statePath, "not a directory", "utf-8");

    expect(
      fingerprintConfigSnapshotAuthoredConfig(
        { gateway: { auth: { token: "test-token" } } },
        { env: { OPENCLAW_STATE_DIR: statePath } as NodeJS.ProcessEnv, homedir: () => home },
      ),
    ).toEqual({ gateway: { auth: { token: "***" } } });
  });

  afterAll(async () => {
    await suiteRootTracker.cleanup();
  });

  afterEach(() => {
    resetPluginStateStoreForTests();
  });
});
