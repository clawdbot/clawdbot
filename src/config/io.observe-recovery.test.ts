import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSON5 from "json5";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CONFIG_CLOBBER_SNAPSHOT_LIMIT } from "./io.clobber-snapshot.js";
import {
  maybeRecoverSuspiciousConfigRead,
  maybeRecoverSuspiciousConfigReadSync,
  promoteConfigSnapshotToLastKnownGood,
  recoverConfigFromLastKnownGood,
  resolveLastKnownGoodConfigPath,
  type ObserveRecoveryDeps,
} from "./io.observe-recovery.js";
import type { ConfigFileSnapshot } from "./types.js";

describe("config observe recovery", () => {
  let fixtureRoot = "";
  let homeCaseId = 0;
  const clobberedUpdateChannelConfig = { update: { channel: "beta" } };
  const clobberedUpdateChannelRaw = `${JSON.stringify(clobberedUpdateChannelConfig, null, 2)}\n`;
  const recoverableTelegramConfig = {
    meta: { lastTouchedAt: "2026-04-22T00:00:00.000Z" },
    update: { channel: "beta" },
    gateway: { mode: "local" },
    channels: { telegram: { enabled: true, dmPolicy: "pairing", groupPolicy: "allowlist" } },
  };

  async function withSuiteHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
    const home = path.join(fixtureRoot, `case-${homeCaseId++}`);
    await fsp.mkdir(home, { recursive: true });
    return await fn(home);
  }

  beforeAll(async () => {
    fixtureRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-config-observe-recovery-"));
  });

  afterAll(async () => {
    await fsp.rm(fixtureRoot, { recursive: true, force: true });
  });

  async function seedConfig(configPath: string, config: Record<string, unknown>): Promise<void> {
    await fsp.mkdir(path.dirname(configPath), { recursive: true });
    await fsp.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  }

  async function seedConfigBackup(configPath: string, config: Record<string, unknown>) {
    await seedConfig(configPath, config);
    await fsp.copyFile(configPath, `${configPath}.bak`);
  }

  async function writeConfigRaw(configPath: string, config: Record<string, unknown>) {
    const raw = `${JSON.stringify(config, null, 2)}\n`;
    await fsp.writeFile(configPath, raw, "utf-8");
    return { raw, parsed: config };
  }

  async function writeClobberedUpdateChannel(configPath: string) {
    await fsp.writeFile(configPath, clobberedUpdateChannelRaw, "utf-8");
    return {
      raw: clobberedUpdateChannelRaw,
      parsed: clobberedUpdateChannelConfig,
    };
  }

  async function readObserveEvents(auditPath: string): Promise<Record<string, unknown>[]> {
    const events: Record<string, unknown>[] = [];
    for (const line of (await fsp.readFile(auditPath, "utf-8")).trim().split("\n")) {
      if (!line) {
        continue;
      }
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.event === "config.observe") {
        events.push(parsed);
      }
    }
    return events;
  }

  async function listClobberFiles(configPath: string): Promise<string[]> {
    const entries = await fsp.readdir(path.dirname(configPath));
    const prefix = `${path.basename(configPath)}.clobbered.`;
    const clobberFiles: string[] = [];
    for (const entry of entries) {
      if (entry.startsWith(prefix)) {
        clobberFiles.push(entry);
      }
    }
    return clobberFiles;
  }

  async function expectPathMissing(targetPath: string): Promise<void> {
    try {
      await fsp.stat(targetPath);
      throw new Error(`Expected ${targetPath} to be missing`);
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    }
  }

  function warnMessages(warn: ReturnType<typeof vi.fn>): string[] {
    return warn.mock.calls.map(([message]) => String(message));
  }

  function expectWarnContaining(warn: ReturnType<typeof vi.fn>, expected: string) {
    expect(warnMessages(warn).join("\n")).toContain(expected);
  }

  function expectWarnNotContaining(warn: ReturnType<typeof vi.fn>, expected: string) {
    expect(warnMessages(warn).join("\n")).not.toContain(expected);
  }

  function observeSuspicious(observe: Record<string, unknown> | undefined): string[] {
    const suspicious = observe?.suspicious;
    expect(Array.isArray(suspicious)).toBe(true);
    return suspicious as string[];
  }

  function expectSuspiciousIncludes(
    observe: Record<string, unknown> | undefined,
    expected: string,
  ) {
    expect(observeSuspicious(observe)).toContain(expected);
  }

  function expectSuspiciousMatching(observe: Record<string, unknown> | undefined, pattern: RegExp) {
    expect(observeSuspicious(observe).some((entry) => pattern.test(entry))).toBe(true);
  }

  async function readLastObserveEvent(
    auditPath: string,
  ): Promise<Record<string, unknown> | undefined> {
    return (await readObserveEvents(auditPath)).at(-1);
  }

  async function recoverClobberedUpdateChannel(params: {
    deps: ObserveRecoveryDeps;
    configPath: string;
  }) {
    return await maybeRecoverSuspiciousConfigRead({
      deps: params.deps,
      configPath: params.configPath,
      raw: clobberedUpdateChannelRaw,
      parsed: clobberedUpdateChannelConfig,
    });
  }

  async function recoverSuspiciousConfigRead(params: {
    deps: ObserveRecoveryDeps;
    configPath: string;
    raw: string;
    parsed: unknown;
  }) {
    return await maybeRecoverSuspiciousConfigRead({
      deps: params.deps,
      configPath: params.configPath,
      raw: params.raw,
      parsed: params.parsed,
    });
  }

  function recoverClobberedUpdateChannelSync(params: {
    deps: ObserveRecoveryDeps;
    configPath: string;
  }) {
    return maybeRecoverSuspiciousConfigReadSync({
      deps: params.deps,
      configPath: params.configPath,
      raw: clobberedUpdateChannelRaw,
      parsed: clobberedUpdateChannelConfig,
    });
  }

  async function makeSnapshot(configPath: string, config: Record<string, unknown>) {
    const raw = `${JSON.stringify(config, null, 2)}\n`;
    await fsp.mkdir(path.dirname(configPath), { recursive: true });
    await fsp.writeFile(configPath, raw, "utf-8");
    return {
      path: configPath,
      exists: true,
      raw,
      parsed: config,
      sourceConfig: config,
      resolved: config,
      valid: true,
      runtimeConfig: config,
      config,
      issues: [],
      warnings: [],
      legacyIssues: [],
    } satisfies ConfigFileSnapshot;
  }

  function makeDeps(
    home: string,
    warn = vi.fn(),
  ): {
    deps: ObserveRecoveryDeps;
    configPath: string;
    auditPath: string;
    warn: ReturnType<typeof vi.fn>;
  } {
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    return {
      deps: {
        fs,
        json5: JSON5,
        env: {} as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: { warn },
      },
      configPath,
      auditPath: path.join(home, ".openclaw", "logs", "config-audit.jsonl"),
      warn,
    };
  }

  function withAsyncHealthWriteFailure(
    deps: ObserveRecoveryDeps,
    healthPath: string,
  ): ObserveRecoveryDeps {
    const writeFile = deps.fs.promises.writeFile.bind(deps.fs.promises);
    return {
      ...deps,
      fs: {
        ...deps.fs,
        promises: {
          ...deps.fs.promises,
          writeFile: async (target, data, options) => {
            if (target === healthPath) {
              throw new Error("health write failed");
            }
            return await writeFile(target, data, options);
          },
        },
      },
    };
  }

  function withSyncHealthWriteFailure(
    deps: ObserveRecoveryDeps,
    healthPath: string,
  ): ObserveRecoveryDeps {
    const writeFileSync = deps.fs.writeFileSync.bind(deps.fs);
    return {
      ...deps,
      fs: {
        ...deps.fs,
        writeFileSync: (target, data, options) => {
          if (target === healthPath) {
            throw new Error("health write failed");
          }
          return writeFileSync(target, data, options);
        },
      },
    };
  }

  it("auto-restores suspicious update-channel-only roots from backup", async () => {
    await withSuiteHome(async (home) => {
      const { deps, configPath, auditPath, warn } = makeDeps(home);
      await seedConfigBackup(configPath, {
        meta: { lastTouchedAt: "2026-04-22T00:00:00.000Z" },
        update: { channel: "beta" },
        browser: { enabled: true },
        gateway: { mode: "local", auth: { mode: "token", token: "secret-token" } },
        channels: { discord: { enabled: true, dmPolicy: "pairing" } },
      });
      await writeClobberedUpdateChannel(configPath);

      const recovered = await recoverClobberedUpdateChannel({ deps, configPath });

      expect((recovered.parsed as { gateway?: { mode?: string } }).gateway?.mode).toBe("local");
      await expect(fsp.readFile(configPath, "utf-8")).resolves.not.toBe(clobberedUpdateChannelRaw);
      expectWarnContaining(warn, "Config auto-restored from backup:");

      const observe = await readLastObserveEvent(auditPath);
      expect(observe?.restoredFromBackup).toBe(true);
      expectSuspiciousIncludes(observe, "gateway-mode-missing-vs-last-good");
      expectSuspiciousIncludes(observe, "update-channel-only-root");
    });
  });

  it("auto-restores when metadata disappears from an otherwise valid config", async () => {
    await withSuiteHome(async (home) => {
      const { deps, configPath, auditPath } = makeDeps(home);
      await seedConfigBackup(configPath, recoverableTelegramConfig);
      const clobbered = await writeConfigRaw(configPath, {
        update: { channel: "beta" },
        gateway: { mode: "local" },
        channels: { telegram: { enabled: true, dmPolicy: "pairing", groupPolicy: "allowlist" } },
      });

      const recovered = await recoverSuspiciousConfigRead({ deps, configPath, ...clobbered });

      expect((recovered.parsed as { meta?: unknown }).meta).toEqual(recoverableTelegramConfig.meta);
      const observe = await readLastObserveEvent(auditPath);
      expect(observe?.restoredFromBackup).toBe(true);
      expectSuspiciousIncludes(observe, "missing-meta-vs-last-good");
    });
  });

  it("auto-restores when gateway mode disappears from the last-good shape", async () => {
    await withSuiteHome(async (home) => {
      const { deps, configPath, auditPath } = makeDeps(home);
      await seedConfigBackup(configPath, recoverableTelegramConfig);
      const clobbered = await writeConfigRaw(configPath, {
        meta: { lastTouchedAt: "2026-04-22T00:00:00.000Z" },
        update: { channel: "beta" },
        channels: { telegram: { enabled: true, dmPolicy: "pairing", groupPolicy: "allowlist" } },
      });

      const recovered = await recoverSuspiciousConfigRead({ deps, configPath, ...clobbered });

      expect((recovered.parsed as { gateway?: { mode?: string } }).gateway?.mode).toBe("local");
      const observe = await readLastObserveEvent(auditPath);
      expect(observe?.restoredFromBackup).toBe(true);
      expectSuspiciousIncludes(observe, "gateway-mode-missing-vs-last-good");
    });
  });

  it("hardens async backup restores to owner-only config permissions", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withSuiteHome(async (home) => {
      const { deps, configPath } = makeDeps(home);
      await seedConfigBackup(configPath, recoverableTelegramConfig);
      await writeClobberedUpdateChannel(configPath);
      await fsp.chmod(configPath, 0o644);

      await recoverClobberedUpdateChannel({ deps, configPath });

      expect((await fsp.stat(configPath)).mode & 0o777).toBe(0o600);
    });
  });

  it("auto-restores after a large size drop against last-good config", async () => {
    await withSuiteHome(async (home) => {
      const { deps, configPath, auditPath } = makeDeps(home);
      await seedConfigBackup(configPath, {
        ...recoverableTelegramConfig,
        channels: {
          telegram: {
            enabled: true,
            dmPolicy: "pairing",
            groupPolicy: "allowlist",
            allowFrom: Array.from({ length: 60 }, (_, index) => `telegram-user-${index}`),
          },
        },
      });
      const clobbered = await writeConfigRaw(configPath, {
        meta: { lastTouchedAt: "2026-04-22T00:00:00.000Z" },
        gateway: { mode: "local" },
      });

      const recovered = await recoverSuspiciousConfigRead({ deps, configPath, ...clobbered });

      expect(
        (recovered.parsed as { channels?: { telegram?: { allowFrom?: string[] } } }).channels
          ?.telegram?.allowFrom,
      ).toHaveLength(60);
      const observe = await readLastObserveEvent(auditPath);
      expect(observe?.restoredFromBackup).toBe(true);
      expectSuspiciousMatching(observe, /^size-drop-vs-last-good:/);
    });
  });

  it("does not restore noncritical config edits", async () => {
    await withSuiteHome(async (home) => {
      const { deps, configPath, auditPath } = makeDeps(home);
      await seedConfigBackup(configPath, recoverableTelegramConfig);
      const editedConfig = {
        ...recoverableTelegramConfig,
        update: { channel: "stable" },
      };
      const edited = await writeConfigRaw(configPath, editedConfig);

      const recovered = await recoverSuspiciousConfigRead({ deps, configPath, ...edited });

      expect(recovered.parsed).toEqual(editedConfig);
      await expect(fsp.readFile(configPath, "utf-8")).resolves.toBe(edited.raw);
      await expectPathMissing(auditPath);
    });
  });

  it("records copyFile failure instead of falsely claiming restore succeeded", async () => {
    await withSuiteHome(async (home) => {
      const { deps, configPath, auditPath, warn } = makeDeps(home);
      await seedConfigBackup(configPath, recoverableTelegramConfig);
      const clobbered = await writeClobberedUpdateChannel(configPath);

      const copyError = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      const failingFs: ObserveRecoveryDeps["fs"] = {
        ...deps.fs,
        promises: {
          ...deps.fs.promises,
          copyFile: () => Promise.reject(copyError),
        },
      };
      const recovered = await maybeRecoverSuspiciousConfigRead({
        deps: { ...deps, fs: failingFs },
        configPath,
        raw: clobbered.raw,
        parsed: clobbered.parsed,
      });

      expect((recovered.parsed as { gateway?: { mode?: string } }).gateway?.mode).toBe("local");
      await expect(fsp.readFile(configPath, "utf-8")).resolves.toBe(clobbered.raw);
      expectWarnContaining(warn, "Config auto-restore from backup failed:");
      expectWarnNotContaining(warn, "Config auto-restored from backup:");

      const observe = await readLastObserveEvent(auditPath);
      expect(observe?.restoredFromBackup).toBe(false);
      expect(observe?.valid).toBe(false);
      expect(observe?.restoreErrorCode).toBe("EACCES");
      expect(observe?.restoreErrorMessage).toBe("EACCES: permission denied");
    });
  });

  it("sync recovery records copyFileSync failure instead of falsely claiming restore succeeded", async () => {
    await withSuiteHome(async (home) => {
      const { deps, configPath, auditPath, warn } = makeDeps(home);
      await seedConfigBackup(configPath, recoverableTelegramConfig);
      const clobbered = await writeClobberedUpdateChannel(configPath);

      const copyError = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      const failingFs: ObserveRecoveryDeps["fs"] = {
        ...deps.fs,
        copyFileSync: () => {
          throw copyError;
        },
      };
      const recovered = maybeRecoverSuspiciousConfigReadSync({
        deps: { ...deps, fs: failingFs },
        configPath,
        raw: clobbered.raw,
        parsed: clobbered.parsed,
      });

      expect((recovered.parsed as { gateway?: { mode?: string } }).gateway?.mode).toBe("local");
      await expect(fsp.readFile(configPath, "utf-8")).resolves.toBe(clobbered.raw);
      expectWarnContaining(warn, "Config auto-restore from backup failed:");
      expectWarnContaining(warn, "EACCES: permission denied");
      expectWarnNotContaining(warn, "Config auto-restored from backup:");

      const observe = await readLastObserveEvent(auditPath);
      expect(observe?.restoredFromBackup).toBe(false);
      expect(observe?.valid).toBe(false);
      expect(observe?.restoreErrorCode).toBe("EACCES");
      expect(observe?.restoreErrorMessage).toBe("EACCES: permission denied");
    });
  });

  it("dedupes repeated suspicious hashes", async () => {
    await withSuiteHome(async (home) => {
      const { deps, configPath, auditPath } = makeDeps(home);
      await seedConfigBackup(configPath, recoverableTelegramConfig);
      await writeClobberedUpdateChannel(configPath);

      await recoverClobberedUpdateChannel({ deps, configPath });
      await recoverClobberedUpdateChannel({ deps, configPath });

      const observeEvents = await readObserveEvents(auditPath);
      expect(observeEvents).toHaveLength(1);
    });
  });

  it("caps concurrent recovery clobber snapshots while preserving audit records", async () => {
    await withSuiteHome(async (home) => {
      const { deps, configPath, auditPath, warn } = makeDeps(home);
      await seedConfigBackup(configPath, recoverableTelegramConfig);
      await writeClobberedUpdateChannel(configPath);

      await Promise.all(
        Array.from({ length: CONFIG_CLOBBER_SNAPSHOT_LIMIT + 18 }, async () => {
          await recoverClobberedUpdateChannel({ deps, configPath });
        }),
      );

      const clobberFiles = await listClobberFiles(configPath);
      expect(clobberFiles.length).toBeLessThanOrEqual(CONFIG_CLOBBER_SNAPSHOT_LIMIT);
      const observeEvents = await readObserveEvents(auditPath);
      expect(observeEvents.length).toBeGreaterThan(0);
      expect(observeEvents.at(-1)).toHaveProperty("clobberedPath");
      let capWarningCount = 0;
      for (const [message] of warn.mock.calls) {
        if (
          typeof message === "string" &&
          message.includes("Config clobber snapshot cap reached")
        ) {
          capWarningCount += 1;
        }
      }
      expect(capWarningCount).toBeLessThanOrEqual(1);
    });
  });

  it("sync recovery uses backup baseline when health state is absent", async () => {
    await withSuiteHome(async (home) => {
      const { deps, configPath, auditPath } = makeDeps(home);
      await seedConfigBackup(configPath, recoverableTelegramConfig);
      await writeClobberedUpdateChannel(configPath);

      const recovered = recoverClobberedUpdateChannelSync({ deps, configPath });

      expect((recovered.parsed as { gateway?: { mode?: string } }).gateway?.mode).toBe("local");
      const observe = await readLastObserveEvent(auditPath);
      expect(observe?.backupHash).toBeTypeOf("string");
      expect(observe?.lastKnownGoodIno ?? null).toBeNull();
    });
  });

  it("hardens sync backup restores to owner-only config permissions", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withSuiteHome(async (home) => {
      const { deps, configPath } = makeDeps(home);
      await seedConfigBackup(configPath, recoverableTelegramConfig);
      await writeClobberedUpdateChannel(configPath);
      await fsp.chmod(configPath, 0o644);

      recoverClobberedUpdateChannelSync({ deps, configPath });

      expect((await fsp.stat(configPath)).mode & 0o777).toBe(0o600);
    });
  });

  it("logs async health-state write failures", async () => {
    await withSuiteHome(async (home) => {
      const { deps, configPath, warn } = makeDeps(home);
      const snapshot = await makeSnapshot(configPath, recoverableTelegramConfig);
      const healthPath = path.join(home, ".openclaw", "logs", "config-health.json");

      await expect(
        promoteConfigSnapshotToLastKnownGood({
          deps: withAsyncHealthWriteFailure(deps, healthPath),
          snapshot,
          logger: deps.logger,
        }),
      ).resolves.toBe(true);

      expectWarnContaining(
        warn,
        `Config health-state write failed: ${healthPath}: health write failed`,
      );
    });
  });

  it("logs sync health-state write failures", async () => {
    await withSuiteHome(async (home) => {
      const { deps, configPath, warn } = makeDeps(home);
      const healthPath = path.join(home, ".openclaw", "logs", "config-health.json");
      await seedConfigBackup(configPath, recoverableTelegramConfig);
      await writeClobberedUpdateChannel(configPath);

      recoverClobberedUpdateChannelSync({
        deps: withSyncHealthWriteFailure(deps, healthPath),
        configPath,
      });

      expectWarnContaining(
        warn,
        `Config health-state write failed: ${healthPath}: health write failed`,
      );
    });
  });

  it("promotes a valid startup config and restores it after an invalid direct edit", async () => {
    await withSuiteHome(async (home) => {
      const { deps, configPath, auditPath, warn } = makeDeps(home);
      const snapshot = await makeSnapshot(configPath, {
        gateway: { mode: "local", auth: { mode: "token", token: "secret-token" } },
        channels: { discord: { enabled: true, dmPolicy: "pairing" } },
      });

      await expect(
        promoteConfigSnapshotToLastKnownGood({ deps, snapshot, logger: deps.logger }),
      ).resolves.toBe(true);
      await expect(fsp.readFile(resolveLastKnownGoodConfigPath(configPath), "utf-8")).resolves.toBe(
        snapshot.raw,
      );

      const brokenRaw = "{ gateway: { mode: 123 } }\n";
      await fsp.writeFile(configPath, brokenRaw, "utf-8");
      const restored = await recoverConfigFromLastKnownGood({
        deps,
        snapshot: {
          ...snapshot,
          raw: brokenRaw,
          parsed: { gateway: { mode: 123 } },
          valid: false,
          issues: [{ path: "gateway.mode", message: "Expected string" }],
        },
        reason: "test-invalid-config",
      });

      expect(restored).toBe(true);
      await expect(fsp.readFile(configPath, "utf-8")).resolves.toBe(snapshot.raw);
      expectWarnContaining(warn, "Config auto-restored from last-known-good:");
      expectWarnContaining(warn, "Rejected validation details: gateway.mode: Expected string.");
      const observe = await readLastObserveEvent(auditPath);
      expect(observe?.restoredFromBackup).toBe(true);
      expect(observe?.restoredBackupPath).toBe(resolveLastKnownGoodConfigPath(configPath));
    });
  });

  it("does not restore stale last-known-good for plugin schema evolution issues", async () => {
    await withSuiteHome(async (home) => {
      const { deps, configPath, warn } = makeDeps(home);
      const staleSnapshot = await makeSnapshot(configPath, {
        gateway: { mode: "local" },
        agents: { defaults: { model: "sonnet-4.6" } },
        plugins: {
          entries: {
            "lossless-claw": {
              enabled: true,
              config: { compactionMode: "legacy" },
            },
          },
        },
      });
      await expect(
        promoteConfigSnapshotToLastKnownGood({
          deps,
          snapshot: staleSnapshot,
          logger: deps.logger,
        }),
      ).resolves.toBe(true);

      const activeConfig = {
        gateway: { mode: "local" },
        agents: { defaults: { model: "gpt-5.4" } },
        plugins: {
          entries: {
            "lossless-claw": {
              enabled: true,
              config: { compactionMode: "adaptive", cacheAwareCompaction: true },
            },
          },
        },
      };
      const active = await writeConfigRaw(configPath, activeConfig);
      const restored = await recoverConfigFromLastKnownGood({
        deps,
        snapshot: {
          ...staleSnapshot,
          raw: active.raw,
          parsed: active.parsed,
          valid: false,
          issues: [
            {
              path: "plugins.entries.lossless-claw.config.cacheAwareCompaction",
              message: "invalid config: must NOT have additional properties",
            },
          ],
        },
        reason: "reload-invalid-config",
      });

      expect(restored).toBe(false);
      await expect(fsp.readFile(configPath, "utf-8")).resolves.toBe(active.raw);
      expectWarnContaining(warn, "Config last-known-good recovery skipped");
    });
  });

  it("does not restore stale last-known-good for plugin minHostVersion skew issues", async () => {
    await withSuiteHome(async (home) => {
      const { deps, configPath } = makeDeps(home);
      const staleSnapshot = await makeSnapshot(configPath, {
        gateway: { mode: "local" },
        plugins: {
          entries: {
            feishu: { enabled: false },
          },
        },
      });
      await expect(
        promoteConfigSnapshotToLastKnownGood({
          deps,
          snapshot: staleSnapshot,
          logger: deps.logger,
        }),
      ).resolves.toBe(true);

      const activeConfig = {
        gateway: { mode: "local" },
        agents: { defaults: { model: "gpt-5.4" } },
        plugins: {
          entries: {
            feishu: { enabled: true, config: { appId: "feishu-app" } },
            whatsapp: { enabled: true, config: { account: "primary" } },
          },
        },
      };
      const active = await writeConfigRaw(configPath, activeConfig);
      const restored = await recoverConfigFromLastKnownGood({
        deps,
        snapshot: {
          ...staleSnapshot,
          raw: active.raw,
          parsed: active.parsed,
          valid: false,
          issues: [
            {
              path: "plugins.entries.feishu",
              message:
                "plugin feishu: plugin requires OpenClaw >=2026.4.23, but this host is 2026.4.22; skipping load",
            },
          ],
        },
        reason: "reload-invalid-config",
      });

      expect(restored).toBe(false);
      await expect(fsp.readFile(configPath, "utf-8")).resolves.toBe(active.raw);
      expect(JSON5.parse(active.raw)).toEqual(activeConfig);
    });
  });

  it("refuses to promote redacted secret placeholders", async () => {
    await withSuiteHome(async (home) => {
      const warn = vi.fn();
      const { deps, configPath } = makeDeps(home, warn);
      const snapshot = await makeSnapshot(configPath, {
        gateway: { mode: "local", auth: { mode: "token", token: "***" } },
      });

      await expect(
        promoteConfigSnapshotToLastKnownGood({ deps, snapshot, logger: deps.logger }),
      ).resolves.toBe(false);
      await expectPathMissing(resolveLastKnownGoodConfigPath(configPath));
      expectWarnContaining(warn, "Config last-known-good promotion skipped");
    });
  });
});
