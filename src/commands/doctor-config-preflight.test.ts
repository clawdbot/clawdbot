// Doctor config preflight tests cover last-known-good snapshots and config snapshot promotion.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyCliProfileEnv } from "../cli/profile.js";
import { promoteConfigSnapshotToLastKnownGood, readConfigFileSnapshot } from "../config/config.js";
import { writeConfigHealthStateToStore } from "../config/io.health-state.js";
import { createConfigHealthFingerprint } from "../config/io.observe-state.js";
import { withEnvOverride, withTempHome, writeOpenClawConfig } from "../config/test-helpers.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  runDoctorConfigPreflight,
  shouldSkipPluginValidationForDoctorConfigPreflight,
} from "./doctor-config-preflight.js";

const noteMock = vi.hoisted(() => vi.fn<(message: string, title?: string) => void>());

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: noteMock }));

async function withStdoutIsTTY<T>(isTTY: boolean, run: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: isTTY });
  try {
    return await run();
  } finally {
    if (original) {
      Object.defineProperty(process.stdout, "isTTY", original);
    } else {
      Reflect.deleteProperty(process.stdout, "isTTY");
    }
  }
}

type ConfigHealthDatabase = Pick<OpenClawStateKyselyDatabase, "config_health_entries">;

function readConfigHealthRow(env: NodeJS.ProcessEnv, configPath: string) {
  const { db } = openOpenClawStateDatabase({ env });
  const healthDb = getNodeSqliteKysely<ConfigHealthDatabase>(db);
  return executeSqliteQueryTakeFirstSync(
    db,
    healthDb
      .selectFrom("config_health_entries")
      .select("config_path")
      .where("config_path", "=", configPath),
  );
}

async function writeLegacyConfig(home: string): Promise<string> {
  const legacyPath = path.join(home, ".clawdbot", "clawdbot.json");
  await fs.mkdir(path.dirname(legacyPath), { recursive: true });
  await fs.writeFile(legacyPath, '{"gateway":{"mode":"local"}}\n', "utf-8");
  return legacyPath;
}

async function seedLastKnownGood(
  home: string,
  configPath: string,
  config: Record<string, unknown>,
): Promise<void> {
  const raw = `${JSON.stringify(config, null, 2)}\n`;
  const lastGoodPath = `${configPath}.last-good`;
  await fs.writeFile(lastGoodPath, raw, "utf-8");
  const fingerprint = createConfigHealthFingerprint({
    raw,
    parsed: config,
    stat: await fs.stat(lastGoodPath),
  });
  writeConfigHealthStateToStore(
    {
      env: { ...process.env, HOME: home },
      homedir: () => home,
      logger: { warn: () => {} },
    },
    {
      entries: {
        [configPath]: {
          lastKnownGood: fingerprint,
          lastPromotedGood: fingerprint,
        },
      },
    },
  );
}

describe("runDoctorConfigPreflight", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    resetLogger();
    noteMock.mockClear();
    vi.restoreAllMocks();
  });

  it("logs config warnings as structured records when stdout is non-interactive", async () => {
    await withStdoutIsTTY(false, async () => {
      setLoggerOverride({ level: "silent", consoleLevel: "warn", consoleStyle: "json" });
      const consoleSink = loggingState.rawConsole ?? console;
      const warnSpy = vi.spyOn(consoleSink, "warn").mockImplementation(() => undefined);

      await withTempHome(async (home) => {
        await writeOpenClawConfig(home, {
          models: { providers: { openai: { contextTokens: 64_000 } } },
        });

        await runDoctorConfigPreflight({
          migrateState: false,
          migrateLegacyConfig: false,
          invalidConfigNote: false,
        });
      });

      const records = warnSpy.mock.calls
        .map(([value]) => String(value).trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(records).toContainEqual(
        expect.objectContaining({
          level: "warn",
          subsystem: "config",
          message: expect.stringContaining("models.providers.openai.contextTokens"),
        }),
      );
      expect(noteMock).not.toHaveBeenCalledWith(expect.anything(), "Config warnings");
    });
  });

  it("renders legacy context-budget notices with their config paths", async () => {
    await withStdoutIsTTY(true, async () => {
      await withTempHome(async (home) => {
        await writeOpenClawConfig(home, {
          models: { providers: { openai: { contextTokens: 64_000 } } },
        });

        await runDoctorConfigPreflight({
          migrateState: false,
          migrateLegacyConfig: false,
          invalidConfigNote: false,
        });

        const output = noteMock.mock.calls.map(([message]) => message).join("\n");
        expect(output).toContain("- models.providers.openai.contextTokens:");
        expect(output).not.toContain("- : ");
      });
    });
  });

  it("supports non-observing config reads", async () => {
    await withTempHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, { gateway: { mode: "local" } });

      await runDoctorConfigPreflight({
        migrateState: false,
        migrateLegacyConfig: false,
        invalidConfigNote: false,
        observe: false,
      });

      expect(readConfigHealthRow({ ...process.env, HOME: home }, configPath)).toBeUndefined();
    });
  });

  it("migrates legacy config into the active state directory", async () => {
    await withTempHome(async (home) => {
      await writeLegacyConfig(home);
      const stateDir = await fs.realpath(await fs.mkdtemp(path.join(home, "custom-state-")));
      const configPath = path.join(stateDir, "openclaw.json");
      const defaultConfigPath = path.join(home, ".openclaw", "openclaw.json");

      await withEnvOverride(
        {
          OPENCLAW_CONFIG_PATH: undefined,
          OPENCLAW_PROFILE: undefined,
          OPENCLAW_STATE_DIR: stateDir,
        },
        async () => {
          const preflight = await runDoctorConfigPreflight({
            migrateState: false,
            invalidConfigNote: false,
          });

          expect(preflight.snapshot.path).toBe(configPath);
          await expect(fs.readFile(configPath, "utf-8")).resolves.toContain('"mode":"local"');
          await expect(fs.access(defaultConfigPath)).rejects.toMatchObject({ code: "ENOENT" });
        },
      );
    });
  });

  it("migrates legacy config into an explicit config path", async () => {
    await withTempHome(async (home) => {
      await writeLegacyConfig(home);
      const configRoot = await fs.realpath(await fs.mkdtemp(path.join(home, "custom-config-")));
      const configPath = path.join(configRoot, "nested", "custom-openclaw.json");

      await withEnvOverride(
        {
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_PROFILE: undefined,
          OPENCLAW_STATE_DIR: undefined,
        },
        async () => {
          const preflight = await runDoctorConfigPreflight({
            migrateState: false,
            invalidConfigNote: false,
          });

          expect(preflight.snapshot.path).toBe(configPath);
          await expect(fs.readFile(configPath, "utf-8")).resolves.toContain('"mode":"local"');
        },
      );
    });
  });

  it("migrates legacy config into the selected profile", async () => {
    await withTempHome(async (home) => {
      await writeLegacyConfig(home);
      const profileStateDir = path.join(home, ".openclaw-work");
      const configPath = path.join(profileStateDir, "openclaw.json");

      await withEnvOverride(
        {
          OPENCLAW_CONFIG_PATH: undefined,
          OPENCLAW_PROFILE: undefined,
          OPENCLAW_STATE_DIR: undefined,
        },
        async () => {
          applyCliProfileEnv({ profile: "work", homedir: () => home });
          const preflight = await runDoctorConfigPreflight({
            migrateState: false,
            invalidConfigNote: false,
          });

          expect(preflight.snapshot.path).toBe(configPath);
          await expect(fs.readFile(configPath, "utf-8")).resolves.toContain('"mode":"local"');
        },
      );
    });
  });

  it("skips plugin schema validation while doctor is running inside update", () => {
    expect(
      shouldSkipPluginValidationForDoctorConfigPreflight({
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      shouldSkipPluginValidationForDoctorConfigPreflight({
        OPENCLAW_UPDATE_IN_PROGRESS: "true",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      shouldSkipPluginValidationForDoctorConfigPreflight({
        OPENCLAW_UPDATE_IN_PROGRESS: "0",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  it("collects legacy config issues outside the normal config read path", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        memorySearch: {
          provider: "local",
          fallback: "none",
        },
      });

      const preflight = await runDoctorConfigPreflight({
        migrateState: false,
        migrateLegacyConfig: false,
        invalidConfigNote: false,
      });

      expect(preflight.snapshot.valid).toBe(false);
      expect(preflight.snapshot.legacyIssues.map((issue) => issue.path)).toContain("memorySearch");
      const memorySearch = (
        preflight.baseConfig as {
          memorySearch?: { provider?: unknown; fallback?: unknown };
        }
      ).memorySearch;
      expect(memorySearch?.provider).toBe("local");
      expect(memorySearch?.fallback).toBe("none");
    });
  });

  it("reports persisted literal and interpolated OTel grpc as legacy config", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        diagnostics: { otel: { enabled: false, protocol: "grpc" } },
      });

      const literal = await runDoctorConfigPreflight({
        migrateState: false,
        migrateLegacyConfig: false,
        invalidConfigNote: false,
      });
      expect(literal.snapshot.legacyIssues).toContainEqual(
        expect.objectContaining({ path: "diagnostics.otel.protocol" }),
      );

      const configPath = literal.snapshot.path;
      await fs.writeFile(
        configPath,
        '{ diagnostics: { otel: { enabled: false, protocol: "${OTEL_PROTOCOL}" } } }\n',
        "utf-8",
      );
      await withEnvOverride({ OTEL_PROTOCOL: "grpc" }, async () => {
        const interpolated = await runDoctorConfigPreflight({
          migrateState: false,
          migrateLegacyConfig: false,
          invalidConfigNote: false,
        });
        expect(interpolated.snapshot.legacyIssues).toContainEqual(
          expect.objectContaining({ path: "diagnostics.otel.protocol" }),
        );
      });
    });
  });

  it("does not treat the process-only OTel protocol fallback as persisted config", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        diagnostics: { otel: { enabled: false } },
      });

      await withEnvOverride({ OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" }, async () => {
        const preflight = await runDoctorConfigPreflight({
          migrateState: false,
          migrateLegacyConfig: false,
          invalidConfigNote: false,
        });
        expect(preflight.snapshot.legacyIssues).not.toContainEqual(
          expect.objectContaining({ path: "diagnostics.otel.protocol" }),
        );
      });
    });
  });

  it("restores invalid config from last-known-good only during repair preflight", async () => {
    await withTempHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, {
        gateway: { mode: "local", port: 19091 },
      });
      await promoteConfigSnapshotToLastKnownGood(await readConfigFileSnapshot());
      const lastGoodRaw = await fs.readFile(configPath, "utf-8");
      await fs.writeFile(configPath, "{ invalid json", "utf-8");

      const inspectOnly = await runDoctorConfigPreflight({
        migrateState: false,
        migrateLegacyConfig: false,
        invalidConfigNote: false,
      });
      expect(inspectOnly.snapshot.valid).toBe(false);

      const repaired = await runDoctorConfigPreflight({
        migrateState: false,
        migrateLegacyConfig: false,
        repairPrefixedConfig: true,
        invalidConfigNote: false,
      });

      expect(repaired.snapshot.valid).toBe(true);
      expect(repaired.snapshot.config.gateway?.mode).toBe("local");
      expect(await fs.readFile(configPath, "utf-8")).toBe(lastGoodRaw);
    });
  });

  it.each([
    ["localhost", "loopback"],
    ["0.0.0.0", "lan"],
  ] as const)(
    "migrates last-known-good gateway bind %s to %s before restoring",
    async (legacyBind, canonicalBind) => {
      await withTempHome(async (home) => {
        const configPath = await writeOpenClawConfig(home, {
          gateway: { mode: "local" },
        });
        await seedLastKnownGood(home, configPath, {
          gateway: { mode: "local", bind: legacyBind },
        });
        const brokenRaw = '{ "gateway": { "mode": "local" },';
        await fs.writeFile(configPath, brokenRaw, "utf-8");

        const repaired = await runDoctorConfigPreflight({
          migrateState: false,
          migrateLegacyConfig: false,
          repairPrefixedConfig: true,
          invalidConfigNote: false,
        });

        expect(repaired.snapshot.valid).toBe(true);
        expect(repaired.snapshot.config.gateway?.bind).toBe(canonicalBind);
        const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
          gateway?: { bind?: string };
        };
        expect(persisted.gateway?.bind).toBe(canonicalBind);
      });
    },
  );

  it("preserves the active config when last-known-good cannot converge", async () => {
    await withTempHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, {
        gateway: { mode: "local" },
      });
      await seedLastKnownGood(home, configPath, {
        gateway: { mode: "local", bind: "not-a-bind-mode" },
      });
      const brokenRaw = '{ "gateway": { "mode": "local" },';
      await fs.writeFile(configPath, brokenRaw, "utf-8");

      const failure = await runDoctorConfigPreflight({
        migrateState: false,
        migrateLegacyConfig: false,
        repairPrefixedConfig: true,
        invalidConfigNote: false,
      }).then(
        () => null,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("cannot be repaired automatically");
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(brokenRaw);
    });
  });

  it("leaves unparseable config untouched and provides recovery steps", async () => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      const brokenRaw = '{ "gateway": { "mode": "local" }, "models": {';
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, brokenRaw, "utf-8");

      await withEnvOverride({ OPENCLAW_CONTAINER_HINT: "repair-test" }, async () => {
        const failures: unknown[] = [];
        for (let attempt = 0; attempt < 3; attempt += 1) {
          failures.push(
            await runDoctorConfigPreflight({
              migrateState: false,
              migrateLegacyConfig: false,
              repairPrefixedConfig: true,
              invalidConfigNote: false,
            }).then(
              () => null,
              (error: unknown) => error,
            ),
          );
        }

        for (const failure of failures) {
          expect(failure).toBeInstanceOf(Error);
          expect((failure as Error).message).toContain(configPath);
          expect((failure as Error).message).toContain(
            "is not parseable and cannot be repaired automatically",
          );
          expect((failure as Error).message).toContain(
            "openclaw --container repair-test config validate",
          );
          expect((failure as Error).message).toContain("hand-edit the file");
          expect((failure as Error).message).toContain("move it aside");
          expect((failure as Error).message).toContain("openclaw --container repair-test onboard");
        }
      });

      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(brokenRaw);
      const entries = await fs.readdir(path.dirname(configPath));
      const clobbered = entries.filter((entry) => entry.startsWith("openclaw.json.clobbered."));
      expect(clobbered).toHaveLength(0);
    });
  });

  it("does not restore last-known-good for stale plugins.deny entries", async () => {
    await withTempHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, {
        gateway: { mode: "local", port: 19091 },
      });
      await promoteConfigSnapshotToLastKnownGood(await readConfigFileSnapshot());
      const currentConfig = {
        gateway: { mode: "local", port: 19092 },
        plugins: { deny: ["missing-deny"] },
      };
      await fs.writeFile(configPath, `${JSON.stringify(currentConfig, null, 2)}\n`, "utf-8");

      const repaired = await runDoctorConfigPreflight({
        migrateState: false,
        migrateLegacyConfig: false,
        repairPrefixedConfig: true,
        invalidConfigNote: false,
      });

      expect(repaired.snapshot.valid).toBe(true);
      expect(repaired.snapshot.config.gateway?.port).toBe(19092);
      expect(repaired.snapshot.config.plugins?.deny).toEqual(["missing-deny"]);
      await expect(fs.readFile(configPath, "utf-8")).resolves.toContain('"missing-deny"');
    });
  });

  it("restores last-known-good for malformed plugin policy values", async () => {
    await withTempHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, {
        gateway: { mode: "local", port: 19091 },
      });
      await promoteConfigSnapshotToLastKnownGood(await readConfigFileSnapshot());
      const lastGoodRaw = await fs.readFile(configPath, "utf-8");
      await fs.writeFile(
        configPath,
        `${JSON.stringify({ gateway: { mode: "local", port: 19092 }, plugins: { deny: "bad" } }, null, 2)}\n`,
        "utf-8",
      );

      const repaired = await runDoctorConfigPreflight({
        migrateState: false,
        migrateLegacyConfig: false,
        repairPrefixedConfig: true,
        invalidConfigNote: false,
      });

      expect(repaired.snapshot.valid).toBe(true);
      expect(repaired.snapshot.config.gateway?.port).toBe(19091);
      await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(lastGoodRaw);
    });
  });
});
