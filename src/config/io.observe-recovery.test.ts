// Covers config IO recovery observation after corrupt or missing files.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSON5 from "json5";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { listConfigAuditRecordsForTests } from "./io.audit.test-support.js";
import { createConfigIO } from "./io.js";
import {
  maybeRecoverSuspiciousConfigRead,
  maybeRecoverSuspiciousConfigReadSync,
  promoteConfigSnapshotToLastKnownGood,
  recoverConfigFromLastKnownGood,
} from "./io.observe-recovery.js";
import type { ConfigFileSnapshot } from "./types.js";

const CONFIG_CLOBBER_SNAPSHOT_LIMIT = 32;
type ConfigHealthDatabase = Pick<OpenClawStateKyselyDatabase, "config_health_entries">;
type ObserveRecoveryDeps = Parameters<typeof maybeRecoverSuspiciousConfigRead>[0]["deps"];

function resolveLastKnownGoodConfigPath(configPath: string): string {
  return `${configPath}.last-good`;
}

describe("config observe recovery", () => {
  let fixtureRoot = "";
  let homeCaseId = 0;
  const clobberedUpdateChannelConfig = { update: { channel: "beta" } };
  const clobberedUpdateChannelRaw = `${JSON.stringify(clobberedUpdateChannelConfig, null, 2)}\n`;
  const recoverableTelegramConfig = {
    meta: { lastTouchedVersion: "2026.4.22" },
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
    closeOpenClawStateDatabaseForTest();
    await fsp.rm(fixtureRoot, { recursive: true, force: true });
  });

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  function readConfigHealthRow(home: string, configPath: string) {
    const { db } = openOpenClawStateDatabase({ env: { HOME: home } as NodeJS.ProcessEnv });
    const healthDb = getNodeSqliteKysely<ConfigHealthDatabase>(db);
    return executeSqliteQueryTakeFirstSync(
      db,
      healthDb
        .selectFrom("config_health_entries")
        .select([
          "config_path",
          "last_known_good_json",
          "last_promoted_good_json",
          "last_observed_suspicious_signature",
        ])
        .where("config_path", "=", configPath),
    );
  }

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
    const stateDir = path.dirname(path.dirname(auditPath));
    return listConfigAuditRecordsForTests({
      env: { OPENCLAW_STATE_DIR: stateDir },
      homedir: () => stateDir,
    }).filter((event) => event.event === "config.observe");
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

  function createTestConfigIO(
    home: string,
    warn = vi.fn(),
    options: { env?: NodeJS.ProcessEnv; observe?: boolean } = {},
  ) {
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    const error = vi.fn();
    return {
      configPath,
      warn,
      error,
      io: createConfigIO({
        fs,
        json5: JSON5,
        env: options.env ?? ({} as NodeJS.ProcessEnv),
        homedir: () => home,
        configPath,
        logger: { warn, error },
        ...(options.observe === false ? { observe: false } : {}),
      }),
    };
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

  function withAsyncChmodFailure(
    deps: ObserveRecoveryDeps,
    targetPath: string,
    error = Object.assign(new Error("EPERM: chmod denied"), { code: "EPERM" }),
  ): ObserveRecoveryDeps {
    const chmod = deps.fs.promises.chmod?.bind(deps.fs.promises);
    return {
      ...deps,
      fs: {
        ...deps.fs,
        promises: {
          ...deps.fs.promises,
          chmod: async (filePath, mode) => {
            if (filePath === targetPath) {
              throw error;
            }
            return await chmod?.(filePath, mode);
          },
        },
      },
    };
  }

  function withSyncChmodFailure(
    deps: ObserveRecoveryDeps,
    targetPath: string,
    error = Object.assign(new Error("EPERM: chmod denied"), { code: "EPERM" }),
  ): ObserveRecoveryDeps {
    const chmodSync = deps.fs.chmodSync?.bind(deps.fs);
    return {
      ...deps,
      fs: {
        ...deps.fs,
        chmodSync: (filePath, mode) => {
          if (filePath === targetPath) {
            throw error;
          }
          return chmodSync?.(filePath, mode);
        },
      },
    };
  }
  it("auto-restores suspicious update-channel-only roots from backup", async () => {
    await withSuiteHome(async (home) => {
      const { deps, configPath, auditPath, warn } = makeDeps(home);
      await seedConfigBackup(configPath, {
        meta: { lastTouchedVersion: "2026.4.22" },
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
        meta: { lastTouchedVersion: "2026.4.22" },
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

  it("warns when async backup restore cannot tighten config permissions", async () => {
    await withSuiteHome(async (home) => {
      const { deps, configPath, warn } = makeDeps(home);
      await seedConfigBackup(configPath, recoverableTelegramConfig);
      const clobbered = await writeClobberedUpdateChannel(configPath);

      const recovered = await maybeRecoverSuspiciousConfigRead({
        deps: withAsyncChmodFailure(deps, configPath),
        configPath,
        raw: clobbered.raw,
        parsed: clobbered.parsed,
      });

      expect((recovered.parsed as { gateway?: { mode?: string } }).gateway?.mode).toBe("local");
      expectWarnContaining(
        warn,
        `Config permission hardening failed (backup restore): ${configPath}: EPERM: chmod denied`,
      );
      expectWarnContaining(warn, `Config auto-restored from backup: ${configPath}`);
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
        meta: { lastTouchedVersion: "2026.4.22" },
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

  it("read snapshots auto-restore tiny valid clobbers before recording them observed", async () => {
    await withSuiteHome(async (home) => {
      const { io, configPath, warn } = createTestConfigIO(home);
      const auditPath = path.join(home, ".openclaw", "logs", "config-audit.jsonl");
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
        meta: { lastTouchedVersion: "2026.5.28" },
      });

      const snapshot = await io.readConfigFileSnapshot({ recoverSuspicious: true });

      expect(snapshot.valid).toBe(true);
      expect(snapshot.config.gateway?.mode).toBe("local");
      await expect(fsp.readFile(configPath, "utf-8")).resolves.not.toBe(clobbered.raw);
      expectWarnContaining(warn, "Config auto-restored from backup:");
      const observeEvents = await readObserveEvents(auditPath);
      expect(observeEvents).toHaveLength(1);
      expect(observeEvents[0]?.restoredFromBackup).toBe(true);
      expectSuspiciousMatching(observeEvents[0], /^size-drop-vs-last-good:/);
      expectSuspiciousIncludes(observeEvents[0], "gateway-mode-missing-vs-last-good");
      await expect(listClobberFiles(configPath)).resolves.toHaveLength(1);
    });
  });

  it("loadConfig auto-restores tiny valid clobbers before using defaults", async () => {
    await withSuiteHome(async (home) => {
      const { io, configPath, warn } = createTestConfigIO(home);
      await seedConfigBackup(configPath, recoverableTelegramConfig);
      await writeConfigRaw(configPath, {
        meta: { lastTouchedVersion: "2026.5.28" },
      });

      const config = io.loadConfig();

      expect(config.gateway?.mode).toBe("local");
      expectWarnContaining(warn, "Config auto-restored from backup:");
    });
  });

  it("loadConfig skips health observation when observation is disabled", async () => {
    await withSuiteHome(async (home) => {
      const { io, configPath } = createTestConfigIO(home, vi.fn(), { observe: false });
      await seedConfig(configPath, { gateway: { mode: "local" } });

      expect(io.loadConfig().gateway?.mode).toBe("local");
      expect(readConfigHealthRow(home, configPath)).toBeUndefined();
    });
  });

  it("loadConfig clears env vars from the discarded clobbered config before rereading backup", async () => {
    await withSuiteHome(async (home) => {
      const env = {} as NodeJS.ProcessEnv;
      const { io, configPath } = createTestConfigIO(home, vi.fn(), { env });
      await seedConfigBackup(configPath, recoverableTelegramConfig);
      await writeConfigRaw(configPath, {
        meta: { lastTouchedVersion: "2026.5.28" },
        env: { vars: { OPENCLAW_CLOBBER_ONLY: "bad" } },
      });

      const config = io.loadConfig();

      expect(config.gateway?.mode).toBe("local");
      expect(env.OPENCLAW_CLOBBER_ONLY).toBeUndefined();
    });
  });

  it("read snapshot recovery clears env vars from the discarded clobbered config", async () => {
    await withSuiteHome(async (home) => {
      const env = {} as NodeJS.ProcessEnv;
      const { io, configPath } = createTestConfigIO(home, vi.fn(), { env });
      await seedConfigBackup(configPath, recoverableTelegramConfig);
      await writeConfigRaw(configPath, {
        meta: { lastTouchedVersion: "2026.5.28" },
        env: { vars: { OPENCLAW_CLOBBER_ONLY: "bad" } },
      });

      const snapshot = await io.readConfigFileSnapshot({ recoverSuspicious: true });

      expect(snapshot.config.gateway?.mode).toBe("local");
      expect(env.OPENCLAW_CLOBBER_ONLY).toBeUndefined();
    });
  });

  it("does not auto-restore read snapshots when observation is disabled", async () => {
    await withSuiteHome(async (home) => {
      const { io, configPath } = createTestConfigIO(home, vi.fn(), { observe: false });
      const auditPath = path.join(home, ".openclaw", "logs", "config-audit.jsonl");
      await seedConfigBackup(configPath, recoverableTelegramConfig);
      const clobbered = await writeConfigRaw(configPath, {
        meta: { lastTouchedVersion: "2026.5.28" },
      });

      const snapshot = await io.readConfigFileSnapshot({ recoverSuspicious: true });

      expect(snapshot.valid).toBe(true);
      expect(snapshot.config.gateway?.mode).toBeUndefined();
      await expect(fsp.readFile(configPath, "utf-8")).resolves.toBe(clobbered.raw);
      await expectPathMissing(auditPath);
    });
  });

  it("does not auto-restore include-authored roots from stale full-file backups", async () => {
    await withSuiteHome(async (home) => {
      const { io, configPath } = createTestConfigIO(home);
      const auditPath = path.join(home, ".openclaw", "logs", "config-audit.jsonl");
      const includedConfig = {
        ...recoverableTelegramConfig,
        channels: {
          telegram: {
            enabled: true,
            dmPolicy: "pairing",
            groupPolicy: "allowlist",
            allowFrom: Array.from({ length: 60 }, (_, index) => `telegram-user-${index}`),
          },
        },
      };
      await seedConfigBackup(configPath, includedConfig);
      await fsp.writeFile(
        path.join(path.dirname(configPath), "base.json5"),
        `${JSON.stringify(includedConfig, null, 2)}\n`,
        "utf-8",
      );
      const includeRootRaw = `{\n  "$include": "./base.json5"\n}\n`;
      await fsp.writeFile(configPath, includeRootRaw, "utf-8");

      const snapshot = await io.readConfigFileSnapshot({ recoverSuspicious: true });

      expect(snapshot.valid).toBe(true);
      expect(snapshot.config.gateway?.mode).toBe("local");
      await expect(fsp.readFile(configPath, "utf-8")).resolves.toBe(includeRootRaw);
      const observe = await readLastObserveEvent(auditPath);
      expect(observe?.restoredFromBackup).toBe(false);
    });
  });

  it("does not auto-restore invalid backup candidates during opted-in reads", async () => {
    await withSuiteHome(async (home) => {
      const { io, configPath } = createTestConfigIO(home);
      await seedConfigBackup(configPath, {
        gateway: { mode: "local" },
        agents: { defaults: { model: 123 } },
      });
      const clobbered = await writeConfigRaw(configPath, {
        meta: { lastTouchedVersion: "2026.5.28" },
      });

      const snapshot = await io.readConfigFileSnapshot({ recoverSuspicious: true });

      expect(snapshot.valid).toBe(true);
      expect(snapshot.config.gateway?.mode).toBeUndefined();
      await expect(fsp.readFile(configPath, "utf-8")).resolves.toBe(clobbered.raw);
      await expect(listClobberFiles(configPath)).resolves.toHaveLength(0);
    });
  });

  it("does not auto-restore backup candidates rejected by the caller", async () => {
    await withSuiteHome(async (home) => {
      const { io, configPath } = createTestConfigIO(home);
      await seedConfigBackup(configPath, recoverableTelegramConfig);
      const clobbered = await writeConfigRaw(configPath, {
        meta: { lastTouchedVersion: "2026.5.28" },
      });
      const allowSuspiciousRecovery = vi.fn(() => false);

      const snapshot = await io.readConfigFileSnapshot({
        recoverSuspicious: true,
        allowSuspiciousRecovery,
      });
      await io.readConfigFileSnapshot({ recoverSuspicious: true, allowSuspiciousRecovery });

      expect(snapshot.valid).toBe(true);
      expect(snapshot.config.gateway?.mode).toBeUndefined();
      expect(allowSuspiciousRecovery).toHaveBeenCalledTimes(2);
      await expect(fsp.readFile(configPath, "utf-8")).resolves.toBe(clobbered.raw);
      await expect(listClobberFiles(configPath)).resolves.toHaveLength(0);
    });
  });

  it("passes the resolved backup candidate to caller recovery policy", async () => {
    await withSuiteHome(async (home) => {
      const { io, configPath } = createTestConfigIO(home);
      await fsp.mkdir(path.dirname(configPath), { recursive: true });
      await fsp.writeFile(
        path.join(path.dirname(configPath), "future-meta.json5"),
        '{ meta: { lastTouchedVersion: "9999.1.1" } }\n',
        "utf-8",
      );
      await seedConfigBackup(configPath, {
        $include: "./future-meta.json5",
        gateway: { mode: "local" },
      });
      const clobbered = await writeConfigRaw(configPath, {});
      let candidateVersion: string | undefined;
      let currentConfig: Record<string, unknown> | undefined;

      await io.readConfigFileSnapshot({
        recoverSuspicious: true,
        allowSuspiciousRecovery: (candidate, current) => {
          candidateVersion = candidate.meta?.lastTouchedVersion;
          currentConfig = current;
          return false;
        },
      });

      expect(candidateVersion).toBe("9999.1.1");
      expect(currentConfig).toBeDefined();
      expect(currentConfig?.meta).toBeUndefined();
      await expect(fsp.readFile(configPath, "utf-8")).resolves.toBe(clobbered.raw);
    });
  });

  it("does not inspect caller policy for backup candidates ineligible for restoration", async () => {
    await withSuiteHome(async (home) => {
      const { io, configPath } = createTestConfigIO(home);
      await seedConfigBackup(configPath, {
        meta: { lastTouchedVersion: "9999.1.1" },
        channels: {
          telegram: {
            enabled: true,
            allowFrom: Array.from({ length: 60 }, (_, index) => `telegram-user-${index}`),
          },
        },
      });
      const clobbered = await writeConfigRaw(configPath, {});
      const allowSuspiciousRecovery = vi.fn(() => false);

      await io.readConfigFileSnapshot({
        recoverSuspicious: true,
        allowSuspiciousRecovery,
      });

      expect(allowSuspiciousRecovery).not.toHaveBeenCalled();
      await expect(fsp.readFile(configPath, "utf-8")).resolves.toBe(clobbered.raw);
    });
  });

  it("validates backup candidates without leaking their env into live state", async () => {
    await withSuiteHome(async (home) => {
      const env = {} as NodeJS.ProcessEnv;
      const { io, configPath } = createTestConfigIO(home, vi.fn(), { env });
      await seedConfigBackup(configPath, {
        gateway: { mode: "local" },
        env: { vars: { OPENCLAW_BACKUP_ONLY: "stale" } },
        agents: { defaults: { model: 123 } },
      });
      await writeConfigRaw(configPath, {
        meta: { lastTouchedVersion: "2026.5.28" },
      });

      await io.readConfigFileSnapshot({ recoverSuspicious: true });

      expect(env.OPENCLAW_BACKUP_ONLY).toBeUndefined();
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

  it("records writeFile failure instead of falsely claiming restore succeeded", async () => {
    await withSuiteHome(async (home) => {
      const { deps, configPath, auditPath, warn } = makeDeps(home);
      await seedConfigBackup(configPath, recoverableTelegramConfig);
      const clobbered = await writeClobberedUpdateChannel(configPath);

      const copyError = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      const writeFile = deps.fs.promises.writeFile.bind(deps.fs.promises);
      const failingFs: ObserveRecoveryDeps["fs"] = {
        ...deps.fs,
        promises: {
          ...deps.fs.promises,
          writeFile: (target, data, options) =>
            target === configPath ? Promise.reject(copyError) : writeFile(target, data, options),
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

  it("sync recovery records writeFileSync failure instead of falsely claiming restore succeeded", async () => {
    await withSuiteHome(async (home) => {
      const { deps, configPath, auditPath, warn } = makeDeps(home);
      await seedConfigBackup(configPath, recoverableTelegramConfig);
      const clobbered = await writeClobberedUpdateChannel(configPath);

      const copyError = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      const writeFileSync = deps.fs.writeFileSync.bind(deps.fs);
      const failingFs: ObserveRecoveryDeps["fs"] = {
        ...deps.fs,
        writeFileSync: (target, data, options) => {
          if (target === configPath) {
            throw copyError;
          }
          return writeFileSync(target, data, options);
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

  it("retries recovery on next launch after a failed writeFile restore", async () => {
    await withSuiteHome(async (home) => {
      const { deps, configPath, auditPath, warn } = makeDeps(home);
      await seedConfigBackup(configPath, recoverableTelegramConfig);
      const clobbered = await writeClobberedUpdateChannel(configPath);

      const copyError = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      const writeFile = deps.fs.promises.writeFile.bind(deps.fs.promises);
      const failingFs: ObserveRecoveryDeps["fs"] = {
        ...deps.fs,
        promises: {
          ...deps.fs.promises,
          writeFile: (target, data, options) =>
            target === configPath ? Promise.reject(copyError) : writeFile(target, data, options),
        },
      };
      await maybeRecoverSuspiciousConfigRead({
        deps: { ...deps, fs: failingFs },
        configPath,
        raw: clobbered.raw,
        parsed: clobbered.parsed,
      });

      expectWarnContaining(warn, "Config auto-restore from backup failed:");
      const firstEvents = await readObserveEvents(auditPath);
      expect(firstEvents).toHaveLength(1);
      expect(firstEvents[0]?.restoredFromBackup).toBe(false);

      const retryResult = await maybeRecoverSuspiciousConfigRead({
        deps,
        configPath,
        raw: clobbered.raw,
        parsed: clobbered.parsed,
      });

      expect((retryResult.parsed as { gateway?: { mode?: string } }).gateway?.mode).toBe("local");
      await expect(fsp.readFile(configPath, "utf-8")).resolves.not.toBe(clobbered.raw);
      const retryEvents = await readObserveEvents(auditPath);
      expect(retryEvents).toHaveLength(2);
      expect(retryEvents[1]?.restoredFromBackup).toBe(true);
    });
  });

  it("sync recovery retries on next launch after a failed writeFileSync restore", async () => {
    await withSuiteHome(async (home) => {
      const { deps, configPath, auditPath, warn } = makeDeps(home);
      await seedConfigBackup(configPath, recoverableTelegramConfig);
      const clobbered = await writeClobberedUpdateChannel(configPath);

      const copyError = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      const writeFileSync = deps.fs.writeFileSync.bind(deps.fs);
      const failingFs: ObserveRecoveryDeps["fs"] = {
        ...deps.fs,
        writeFileSync: (target, data, options) => {
          if (target === configPath) {
            throw copyError;
          }
          return writeFileSync(target, data, options);
        },
      };
      maybeRecoverSuspiciousConfigReadSync({
        deps: { ...deps, fs: failingFs },
        configPath,
        raw: clobbered.raw,
        parsed: clobbered.parsed,
      });

      expectWarnContaining(warn, "Config auto-restore from backup failed:");
      const firstEvents = await readObserveEvents(auditPath);
      expect(firstEvents).toHaveLength(1);
      expect(firstEvents[0]?.restoredFromBackup).toBe(false);

      const retryResult = maybeRecoverSuspiciousConfigReadSync({
        deps,
        configPath,
        raw: clobbered.raw,
        parsed: clobbered.parsed,
      });

      expect((retryResult.parsed as { gateway?: { mode?: string } }).gateway?.mode).toBe("local");
      await expect(fsp.readFile(configPath, "utf-8")).resolves.not.toBe(clobbered.raw);
      const retryEvents = await readObserveEvents(auditPath);
      expect(retryEvents).toHaveLength(2);
      expect(retryEvents[1]?.restoredFromBackup).toBe(true);
    });
  });

  it("restores the exact async backup bytes approved by validation", async () => {
    await withSuiteHome(async (home) => {
      const { deps, configPath } = makeDeps(home);
      await seedConfigBackup(configPath, recoverableTelegramConfig);
      const backupPath = `${configPath}.bak`;
      const approvedRaw = await fsp.readFile(backupPath, "utf-8");
      const replacementRaw = `${JSON.stringify({ gateway: { mode: "remote" } }, null, 2)}\n`;
      const clobbered = await writeClobberedUpdateChannel(configPath);

      await maybeRecoverSuspiciousConfigRead({
        deps,
        configPath,
        raw: clobbered.raw,
        parsed: clobbered.parsed,
        validateBackup: async () => {
          await fsp.writeFile(backupPath, replacementRaw, "utf-8");
          return true;
        },
      });

      await expect(fsp.readFile(backupPath, "utf-8")).resolves.toBe(replacementRaw);
      await expect(fsp.readFile(configPath, "utf-8")).resolves.toBe(approvedRaw);
    });
  });

  it("restores the exact sync backup bytes approved by validation", async () => {
    await withSuiteHome(async (home) => {
      const { deps, configPath } = makeDeps(home);
      await seedConfigBackup(configPath, recoverableTelegramConfig);
      const backupPath = `${configPath}.bak`;
      const approvedRaw = await fsp.readFile(backupPath, "utf-8");
      const replacementRaw = `${JSON.stringify({ gateway: { mode: "remote" } }, null, 2)}\n`;
      const clobbered = await writeClobberedUpdateChannel(configPath);

      maybeRecoverSuspiciousConfigReadSync({
        deps,
        configPath,
        raw: clobbered.raw,
        parsed: clobbered.parsed,
        validateBackupSync: () => {
          fs.writeFileSync(backupPath, replacementRaw, "utf-8");
          return true;
        },
      });

      await expect(fsp.readFile(backupPath, "utf-8")).resolves.toBe(replacementRaw);
      await expect(fsp.readFile(configPath, "utf-8")).resolves.toBe(approvedRaw);
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

  it("warns when sync backup restore cannot tighten config permissions", async () => {
    await withSuiteHome(async (home) => {
      const { deps, configPath, warn } = makeDeps(home);
      await seedConfigBackup(configPath, recoverableTelegramConfig);
      await writeClobberedUpdateChannel(configPath);

      recoverClobberedUpdateChannelSync({
        deps: withSyncChmodFailure(deps, configPath),
        configPath,
      });

      expectWarnContaining(
        warn,
        `Config permission hardening failed (backup restore): ${configPath}: EPERM: chmod denied`,
      );
      expectWarnContaining(warn, `Config auto-restored from backup: ${configPath}`);
    });
  });

  it("logs async health-state write failures", async () => {
    await withSuiteHome(async (home) => {
      const { deps, configPath, warn } = makeDeps(home);
      const snapshot = await makeSnapshot(configPath, recoverableTelegramConfig);

      await expect(
        promoteConfigSnapshotToLastKnownGood({ deps, snapshot, logger: deps.logger }),
      ).resolves.toBe(true);

      await expectPathMissing(path.join(home, ".openclaw", "logs", "config-health.json"));
      const row = readConfigHealthRow(home, configPath);
      expect(row).toMatchObject({
        config_path: configPath,
        last_known_good_json: expect.any(String),
        last_promoted_good_json: expect.any(String),
        last_observed_suspicious_signature: null,
      });
      expectWarnNotContaining(warn, "Config health-state write failed");
    });
  });

  it("writes sync health state to SQLite", async () => {
    await withSuiteHome(async (home) => {
      const { deps, configPath, warn } = makeDeps(home);
      await seedConfigBackup(configPath, recoverableTelegramConfig);
      await writeClobberedUpdateChannel(configPath);

      recoverClobberedUpdateChannelSync({ deps, configPath });

      await expectPathMissing(path.join(home, ".openclaw", "logs", "config-health.json"));
      const row = readConfigHealthRow(home, configPath);
      expect(row).toMatchObject({
        config_path: configPath,
        last_observed_suspicious_signature: expect.any(String),
      });
      expectWarnNotContaining(warn, "Config health-state write failed");
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

  it("warns when last-known-good promotion cannot tighten snapshot permissions", async () => {
    await withSuiteHome(async (home) => {
      const { deps, configPath, warn } = makeDeps(home);
      const snapshot = await makeSnapshot(configPath, recoverableTelegramConfig);
      const lastGoodPath = resolveLastKnownGoodConfigPath(configPath);

      await expect(
        promoteConfigSnapshotToLastKnownGood({
          deps: withAsyncChmodFailure(deps, lastGoodPath),
          snapshot,
          logger: deps.logger,
        }),
      ).resolves.toBe(true);

      expectWarnContaining(
        warn,
        `Config permission hardening failed (last-known-good promotion): ${lastGoodPath}: EPERM: chmod denied`,
      );
    });
  });

  it("warns when last-known-good recovery cannot tighten restored config permissions", async () => {
    await withSuiteHome(async (home) => {
      const { deps, configPath, warn } = makeDeps(home);
      const snapshot = await makeSnapshot(configPath, {
        gateway: { mode: "local", auth: { mode: "token", token: "secret-token" } },
        channels: { discord: { enabled: true, dmPolicy: "pairing" } },
      });
      await expect(
        promoteConfigSnapshotToLastKnownGood({ deps, snapshot, logger: deps.logger }),
      ).resolves.toBe(true);

      const brokenRaw = "{ gateway: { mode: 123 } }\n";
      await fsp.writeFile(configPath, brokenRaw, "utf-8");
      await expect(
        recoverConfigFromLastKnownGood({
          deps: withAsyncChmodFailure(deps, configPath),
          snapshot: {
            ...snapshot,
            raw: brokenRaw,
            parsed: { gateway: { mode: 123 } },
            valid: false,
            issues: [{ path: "gateway.mode", message: "Expected string" }],
          },
          reason: "test-invalid-config",
        }),
      ).resolves.toBe(true);

      expectWarnContaining(
        warn,
        `Config permission hardening failed (last-known-good recovery): ${configPath}: EPERM: chmod denied`,
      );
      expectWarnContaining(warn, "Config auto-restored from last-known-good:");
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
