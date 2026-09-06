import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { withEnvOverride, withTempHome, writeOpenClawConfig } from "../config/test-helpers.js";
import { makeCronJob } from "../cron/delivery.test-helpers.js";
import { cronStoreKey } from "../cron/store/key.js";
import { loadCronRows } from "../cron/store/row-codec.js";
import {
  runInitialConfigWriteHealth,
  runWriteConfigHealth,
} from "../flows/doctor-health-contribution-runners.config.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { prepareDoctorContext } from "./doctor-config-flow.test-support.js";
import { normalizeCompatibilityConfigValues } from "./doctor/shared/legacy-config-core-migrate.js";

describe("Doctor workspace persistence", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  it("persists legacy channel command owners once and reports each rewritten entry", async () => {
    await withTempHome(async (home) => {
      await withEnvOverride({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        const preserved = [
          "discord:100000000000000002",
          "matrix:@owner:example.org",
          "slack:team:T123:user:U456",
          "unknown:user:123",
          "discord:user:user:123",
          "discord:user:",
          "discord:user:*",
          "123",
          456,
        ];
        const canonical = ["discord:100000000000000001", "telegram:123", "slack:U123"];
        const configPath = await writeOpenClawConfig(home, {
          meta: { lastTouchedVersion: "2026.7.1-2" },
          agents: { list: [{ id: "main" }] },
          commands: {
            ownerAllowFrom: [
              "discord:user:100000000000000001",
              "telegram:user:123",
              "slack:user:U123",
              ...preserved,
            ],
          },
          gateway: { mode: "local" },
          plugins: { enabled: false },
        });
        const ctx = await prepareDoctorContext(configPath);
        for (const index of [0, 1, 2]) {
          expect(ctx.configResult.pendingChangePanels?.join("\n")).toContain(
            `commands.ownerAllowFrom[${index}]`,
          );
        }
        await runInitialConfigWriteHealth(ctx);
        expect(ctx.configWriteRefusal).toBeUndefined();
        const saved = await readConfigFileSnapshot();
        expect(saved.config.commands?.ownerAllowFrom).toEqual([...canonical, ...preserved]);
        const bytes = await fs.readFile(configPath, "utf8");
        const repeated = await prepareDoctorContext(configPath);
        expect(repeated.configResult.shouldWriteConfig).toBe(false);
        await runInitialConfigWriteHealth(repeated);
        expect(await fs.readFile(configPath, "utf8")).toBe(bytes);
      });
    });
  });

  it.each([
    ["entries", false],
    ["list", false],
    ["entries", true],
    ["list", true],
  ] as const)(
    "persists per-agent migrations with explicit ownership (%s, update in progress: %s)",
    async (shape, updateInProgress) => {
      await withTempHome(async (home) => {
        await withEnvOverride(
          {
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
            OPENCLAW_UPDATE_IN_PROGRESS: updateInProgress ? "1" : undefined,
          },
          async () => {
            const entries = {
              ops: {
                memorySearch: { enabled: false, extraPaths: [path.join(home, "notes")] },
                sandbox: { perSession: true },
                model: { primary: "openai/gpt-5.6-sol", timeoutMs: 20_000 },
              },
              research: { memory: { search: { provider: "auto" } } },
            };
            const configPath = await writeOpenClawConfig(home, {
              agents: {
                ownership: "explicit",
                ...(shape === "entries"
                  ? { entries }
                  : {
                      list: Object.entries(entries).map(([id, entry]) =>
                        Object.assign({ id }, entry),
                      ),
                    }),
              },
              gateway: { mode: "local" },
              plugins: { enabled: false },
            });
            expect((await readConfigFileSnapshot()).valid).toBe(false);

            const ctx = await prepareDoctorContext(configPath);
            await runInitialConfigWriteHealth(ctx);
            expect(ctx.configWriteRefusal).toBeUndefined();

            const saved = JSON.parse(await fs.readFile(configPath, "utf-8"));
            expect(saved.agents.entries.ops).toEqual({
              memory: { search: entries.ops.memorySearch },
              sandbox: { scope: "session" },
              model: { primary: "openai/gpt-5.6-sol" },
            });
            expect(saved.agents.ownership).toBe("explicit");
            expect(saved.agents.entries.research).toEqual({
              memory: { search: { provider: "openai" } },
            });
            expect((await readConfigFileSnapshot()).valid).toBe(true);
            expect((await prepareDoctorContext(configPath)).configResult.shouldWriteConfig).toBe(
              false,
            );
          },
        );
      });
    },
  );

  it.each(["entries", "list"])(
    "persists explicit ownership for a markerless multi-agent %s roster",
    async (shape) => {
      await withTempHome(async (home) => {
        await withEnvOverride({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
          const entries = {
            ops: { workspace: path.join(home, "ops") },
            research: { workspace: path.join(home, "research") },
          };
          const configPath = await writeOpenClawConfig(home, {
            agents:
              shape === "entries"
                ? { entries }
                : {
                    list: Object.entries(entries).map(([id, entry]) => ({
                      id,
                      workspace: entry.workspace,
                    })),
                  },
            gateway: { mode: "local" },
            plugins: { enabled: false },
          });
          expect((await readConfigFileSnapshot()).valid).toBe(false);

          const ctx = await prepareDoctorContext(configPath);
          await runInitialConfigWriteHealth(ctx);

          const saved = JSON.parse(await fs.readFile(configPath, "utf-8"));
          expect(saved.agents).toEqual({ ownership: "explicit", entries });
          expect((await readConfigFileSnapshot()).valid).toBe(true);
          expect((await prepareDoctorContext(configPath)).configResult.shouldWriteConfig).toBe(
            false,
          );
        });
      });
    },
  );

  it.each([
    { kind: "shared", legacyId: "main" },
    { kind: "implicit", legacyId: "main" },
    { kind: "shared", legacyId: " Main " },
    { kind: "implicit", legacyId: " Main " },
  ])(
    "preserves the markerless $legacyId agent's $kind workspace through Doctor persistence",
    async ({ kind, legacyId }) => {
      await withTempHome(async (home) => {
        await withEnvOverride(
          { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1", OPENCLAW_WORKSPACE_DIR: undefined },
          async () => {
            const workspace = path.join(
              home,
              kind === "shared" ? "shared-workspace" : ".openclaw/workspace",
            );
            await fs.mkdir(path.join(workspace, "memory"), { recursive: true });
            const originals = {
              "AGENTS.md": "# Existing agent\n\nKeep the original workspace.\n",
              "SOUL.md": "# Existing character\n",
              "IDENTITY.md": "# Original identity\n",
              "USER.md": "# Original preferences\n",
              "MEMORY.md": "# Original durable memory\n",
              "memory/2026-07-01.md": "Historical memory remains in this workspace.\n",
            };
            for (const [name, content] of Object.entries(originals)) {
              await fs.writeFile(path.join(workspace, name), content);
            }
            const configPath = await writeOpenClawConfig(home, {
              agents: {
                ...(kind === "shared" ? { defaults: { workspace } } : {}),
                list: [{ id: legacyId }, { id: "other" }],
              },
              gateway: { mode: "local" },
              plugins: { enabled: false },
            });
            const before = await readConfigFileSnapshot();
            expect(before.valid).toBe(false);
            if (legacyId === "main") {
              expect(resolveAgentWorkspaceDir(before.sourceConfig, "main")).toBe(workspace);
            } else {
              expect(before.sourceConfig.agents?.list?.[0]?.id).toBe(legacyId);
            }

            const ctx = await prepareDoctorContext(configPath);
            await runInitialConfigWriteHealth(ctx);
            const saved = await readConfigFileSnapshot();
            expect(saved.valid).toBe(true);
            expect(saved.config.agents?.ownership).toBe("explicit");
            expect(saved.config.agents?.entries?.main?.workspace).toBe(workspace);
            expect(saved.config.agents?.defaults?.systemAgent).toBeUndefined();
            expect(saved.config.bindings).toBeUndefined();
            expect(resolveAgentWorkspaceDir(saved.config, "main")).toBe(workspace);
            for (const [name, content] of Object.entries(originals)) {
              expect(await fs.readFile(path.join(workspace, name), "utf8")).toBe(content);
            }
            expect((await prepareDoctorContext(configPath)).configResult.shouldWriteConfig).toBe(
              false,
            );
          },
        );
      });
    },
  );

  it.each(["entries", "list", "noncanonical list"])(
    "repairs workspace and heartbeat values from %s through snapshot, doctor, and write",
    async (shape) => {
      await withTempHome(async (home) => {
        await withEnvOverride({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
          const agent = {
            workspace: null,
            heartbeat: { every: "30m", activeHours: { start: "99:99", end: "17:00" } },
          };
          const configPath = await writeOpenClawConfig(home, {
            agents:
              shape === "entries"
                ? { entries: { ops: agent } }
                : { list: [{ id: shape === "list" ? "ops" : " Ops ", ...agent }] },
            gateway: { mode: "local" },
            plugins: { enabled: false },
          });
          const before = await readConfigFileSnapshot();
          expect(before.valid).toBe(false);
          if (shape === "noncanonical list") {
            expect(before.sourceConfig.agents?.list).toHaveLength(1);
          } else {
            expect(before.sourceConfig.agents?.entries?.ops).toEqual(agent);
            expect(before.sourceConfig.agents).not.toHaveProperty("list");
          }

          const ctx = await prepareDoctorContext(configPath);
          expect(ctx.configResult.shouldWriteConfig).toBe(true);
          expect(ctx.cfg.agents?.entries?.ops).toEqual({ heartbeat: { every: "30m" } });
          await runInitialConfigWriteHealth(ctx);

          const saved = JSON.parse(await fs.readFile(configPath, "utf-8"));
          expect(saved.agents.entries.ops).toEqual({ heartbeat: { every: "30m" } });
          expect(saved.agents).not.toHaveProperty("list");
          expect((await readConfigFileSnapshot()).valid).toBe(true);
          expect((await prepareDoctorContext(configPath)).configResult.shouldWriteConfig).toBe(
            false,
          );
        });
      });
    },
  );

  it("repairs a legacy candidate without writing when include ownership blocks migration", async () => {
    await withTempHome(async (home) => {
      await withEnvOverride({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        const configPath = await writeOpenClawConfig(home, {
          agents: {
            list: [
              { id: " Ops ", workspace: null, heartbeat: { activeHours: { start: "99:99" } } },
            ],
          },
          diagnostics: { otel: { $include: "otel.json" } },
          gateway: { mode: "local" },
          plugins: { enabled: false },
        });
        const includePath = path.join(path.dirname(configPath), "otel.json");
        await fs.writeFile(includePath, JSON.stringify({ protocol: "grpc" }));
        const original = await fs.readFile(configPath, "utf-8");
        const before = await readConfigFileSnapshot();
        expect(before.sourceConfig.agents?.list).toHaveLength(1);
        expect(normalizeCompatibilityConfigValues(before.sourceConfig).config.agents?.list).toEqual(
          [{ id: " Ops ", heartbeat: {} }],
        );

        const ctx = await prepareDoctorContext(configPath);
        expect(ctx.configResult.shouldWriteConfig).toBe(false);
        await runInitialConfigWriteHealth(ctx);
        expect(await fs.readFile(configPath, "utf-8")).toBe(original);
        expect(JSON.parse(await fs.readFile(includePath, "utf-8"))).toEqual({ protocol: "grpc" });
      });
    });
  });

  it("keeps the legacy owner on the shared workspace across later health writes", async () => {
    await withTempHome(async (home) => {
      await withEnvOverride({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        const workspace = path.join(home, "shared-workspace");
        const configPath = await writeOpenClawConfig(home, {
          agents: {
            defaults: { workspace },
            entries: {
              main: { default: true },
              cursor: { workspace },
            },
          },
          gateway: { mode: "local" },
          plugins: { enabled: false },
        });
        const ctx = await prepareDoctorContext(configPath);

        await runInitialConfigWriteHealth(ctx);
        expect((await readConfigFileSnapshot()).config.agents?.entries?.main?.workspace).toBe(
          workspace,
        );

        ctx.cfg = {
          ...ctx.cfg,
          gateway: { ...ctx.cfg.gateway, bind: "lan" },
        };
        await runWriteConfigHealth(ctx);

        const snapshot = await readConfigFileSnapshot();
        expect(snapshot.valid).toBe(true);
        expect(snapshot.config.agents?.ownership).toBe("explicit");
        expect(snapshot.config.agents?.entries?.main?.workspace).toBe(workspace);
      });
    });
  });

  it("persists cron runtime policy on the retained owner before rewriting its model", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      await withEnvOverride(
        { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1", OPENCLAW_STATE_DIR: stateDir },
        async () => {
          const configPath = await writeOpenClawConfig(home, {
            agents: {
              defaults: { systemAgent: { agentId: "ops" } },
              entries: { main: { default: true }, ops: {} },
            },
            gateway: { mode: "local" },
            plugins: { enabled: false },
          });
          const storePath = path.join(stateDir, "cron", "jobs.json");
          await fs.mkdir(path.dirname(storePath), { recursive: true });
          await fs.writeFile(
            storePath,
            JSON.stringify({
              version: 1,
              jobs: [
                makeCronJob({
                  id: "retained-owner",
                  enabled: false,
                  payload: {
                    kind: "agentTurn",
                    message: "Do not run this disabled job",
                    model: "codex/gpt-5.6-sol",
                  },
                }),
              ],
            }),
          );

          let firstPolicies: unknown;
          let firstRows: unknown;
          for (const pass of [1, 2]) {
            const ctx = await prepareDoctorContext(configPath);
            await runInitialConfigWriteHealth(ctx);
            await runWriteConfigHealth(ctx);
            const snapshot = await readConfigFileSnapshot();
            const policies = {
              main: snapshot.config.agents?.entries?.main?.models,
              ops: snapshot.config.agents?.entries?.ops?.models,
            };
            const rows = loadCronRows(openOpenClawStateDatabase().db, cronStoreKey(storePath));
            expect.soft(snapshot.valid, `pass ${pass}`).toBe(true);
            expect.soft(snapshot.config.agents?.defaults?.systemAgent?.agentId).toBe("ops");
            expect.soft(policies, `pass ${pass}`).toEqual({
              main: { "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } } },
              ops: undefined,
            });
            expect.soft(rows).toHaveLength(1);
            expect.soft(rows[0]?.agent_id).toBe("main");
            expect
              .soft(
                rows.map((row) => JSON.parse(row.job_json)),
                `pass ${pass}`,
              )
              .toMatchObject([{ agentId: "main", payload: { model: "openai/gpt-5.6-sol" } }]);
            if (pass === 2) {
              expect.soft(policies).toEqual(firstPolicies);
              expect.soft(rows).toEqual(firstRows);
            }
            firstPolicies = policies;
            firstRows = rows;
          }
        },
      );
    });
  });
});
