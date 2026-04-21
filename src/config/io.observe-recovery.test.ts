import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSON5 from "json5";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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

  async function writeClobberedUpdateChannel(configPath: string) {
    await fsp.writeFile(configPath, clobberedUpdateChannelRaw, "utf-8");
    return {
      raw: clobberedUpdateChannelRaw,
      parsed: clobberedUpdateChannelConfig,
    };
  }

  async function readObserveEvents(auditPath: string): Promise<Record<string, unknown>[]> {
    const lines = (await fsp.readFile(auditPath, "utf-8")).trim().split("\n").filter(Boolean);
    return lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.event === "config.observe");
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

  it("auto-restores suspicious update-channel-only roots from backup", async () => {
    await withSuiteHome(async (home) => {
      const { deps, configPath, auditPath, warn } = makeDeps(home);
      await seedConfigBackup(configPath, {
        update: { channel: "beta" },
        browser: { enabled: true },
        gateway: { mode: "local", auth: { mode: "token", token: "secret-token" } },
        channels: { discord: { enabled: true, dmPolicy: "pairing" } },
      });
      await writeClobberedUpdateChannel(configPath);

      const recovered = await recoverClobberedUpdateChannel({ deps, configPath });

      expect((recovered.parsed as { gateway?: { mode?: string } }).gateway?.mode).toBe("local");
      await expect(fsp.readFile(configPath, "utf-8")).resolves.not.toBe(clobberedUpdateChannelRaw);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Config auto-restored from backup:"),
      );

      const observe = await readLastObserveEvent(auditPath);
      expect(observe?.restoredFromBackup).toBe(true);
      expect(observe?.suspicious).toEqual(
        expect.arrayContaining(["gateway-mode-missing-vs-last-good", "update-channel-only-root"]),
      );
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
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Config auto-restored from last-known-good:"),
      );
      const observe = await readLastObserveEvent(auditPath);
      expect(observe?.restoredFromBackup).toBe(true);
      expect(observe?.restoredBackupPath).toBe(resolveLastKnownGoodConfigPath(configPath));
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
      await expect(fsp.stat(resolveLastKnownGoodConfigPath(configPath))).rejects.toThrow();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Config last-known-good promotion skipped"),
      );
    });
  });
});
