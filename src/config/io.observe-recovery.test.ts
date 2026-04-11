import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSON5 from "json5";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  maybeRecoverSuspiciousConfigRead,
  maybeRecoverSuspiciousConfigReadSync,
  type ObserveRecoveryDeps,
} from "./io.observe-recovery.js";

describe("config observe recovery", () => {
  let fixtureRoot = "";
  let homeCaseId = 0;

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
      await seedConfig(configPath, {
        update: { channel: "beta" },
        browser: { enabled: true },
        gateway: { mode: "local", auth: { mode: "token", token: "secret-token" } },
        channels: { discord: { enabled: true, dmPolicy: "pairing" } },
      });
      await fsp.copyFile(configPath, `${configPath}.bak`);

      const clobberedRaw = `${JSON.stringify({ update: { channel: "beta" } }, null, 2)}\n`;
      await fsp.writeFile(configPath, clobberedRaw, "utf-8");

      const recovered = await maybeRecoverSuspiciousConfigRead({
        deps,
        configPath,
        raw: clobberedRaw,
        parsed: { update: { channel: "beta" } },
      });

      expect((recovered.parsed as { gateway?: { mode?: string } }).gateway?.mode).toBe("local");
      await expect(fsp.readFile(configPath, "utf-8")).resolves.not.toBe(clobberedRaw);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Config auto-restored from backup:"),
      );

      const lines = (await fsp.readFile(auditPath, "utf-8")).trim().split("\n").filter(Boolean);
      const observe = lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .findLast((line) => line.event === "config.observe");
      expect(observe?.restoredFromBackup).toBe(true);
      expect(observe?.suspicious).toEqual(
        expect.arrayContaining(["gateway-mode-missing-vs-last-good", "update-channel-only-root"]),
      );
    });
  });

  it("dedupes repeated suspicious hashes", async () => {
    await withSuiteHome(async (home) => {
      const { deps, configPath, auditPath } = makeDeps(home);
      await seedConfig(configPath, {
        update: { channel: "beta" },
        gateway: { mode: "local" },
        channels: { telegram: { enabled: true, dmPolicy: "pairing", groupPolicy: "allowlist" } },
      });
      await fsp.copyFile(configPath, `${configPath}.bak`);

      const clobberedRaw = `${JSON.stringify({ update: { channel: "beta" } }, null, 2)}\n`;
      await fsp.writeFile(configPath, clobberedRaw, "utf-8");

      await maybeRecoverSuspiciousConfigRead({
        deps,
        configPath,
        raw: clobberedRaw,
        parsed: { update: { channel: "beta" } },
      });
      await maybeRecoverSuspiciousConfigRead({
        deps,
        configPath,
        raw: clobberedRaw,
        parsed: { update: { channel: "beta" } },
      });

      const lines = (await fsp.readFile(auditPath, "utf-8")).trim().split("\n").filter(Boolean);
      const observeEvents = lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line.event === "config.observe");
      expect(observeEvents).toHaveLength(1);
    });
  });

  it("sync recovery uses backup baseline when health state is absent", async () => {
    await withSuiteHome(async (home) => {
      const { deps, configPath, auditPath } = makeDeps(home);
      await seedConfig(configPath, {
        update: { channel: "beta" },
        gateway: { mode: "local" },
        channels: { telegram: { enabled: true, dmPolicy: "pairing", groupPolicy: "allowlist" } },
      });
      await fsp.copyFile(configPath, `${configPath}.bak`);

      const clobberedRaw = `${JSON.stringify({ update: { channel: "beta" } }, null, 2)}\n`;
      await fsp.writeFile(configPath, clobberedRaw, "utf-8");

      const recovered = maybeRecoverSuspiciousConfigReadSync({
        deps,
        configPath,
        raw: clobberedRaw,
        parsed: { update: { channel: "beta" } },
      });

      expect((recovered.parsed as { gateway?: { mode?: string } }).gateway?.mode).toBe("local");
      const lines = (await fsp.readFile(auditPath, "utf-8")).trim().split("\n").filter(Boolean);
      const observe = lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .findLast((line) => line.event === "config.observe");
      expect(observe?.backupHash).toBeTypeOf("string");
      expect(observe?.lastKnownGoodIno ?? null).toBeNull();
    });
  });
});
