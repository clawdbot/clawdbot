// Exercises legacy values through the actual snapshot, Doctor, atomic write, and reread.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readConfigFileSnapshot } from "../config/config.js";
import { withEnvOverride, withTempHome, writeOpenClawConfig } from "../config/test-helpers.js";
import { runInitialConfigWriteHealth } from "../flows/doctor-health-contribution-runners.config.js";
import type { DoctorHealthFlowContext } from "../flows/doctor-health-contribution-types.js";
import type { RuntimeEnv } from "../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { loadAndMaybeMigrateDoctorConfig } from "./doctor-config-flow.js";
import { createDoctorPrompter, type DoctorOptions } from "./doctor-prompter.js";

async function repairConfig(configPath: string) {
  const runtime: RuntimeEnv = { error: vi.fn(), exit: vi.fn(), log: vi.fn() };
  const options: DoctorOptions = { nonInteractive: true, repair: true };
  const prompter = createDoctorPrompter({ runtime, options });
  const configResult = await loadAndMaybeMigrateDoctorConfig({
    options,
    confirm: (params) => prompter.confirm(params),
    runtime,
    prompter,
  });
  const ctx: DoctorHealthFlowContext = {
    runtime,
    options,
    prompter,
    configResult,
    cfg: configResult.cfg,
    cfgForPersistence: structuredClone(configResult.cfg),
    sourceConfigValid: configResult.sourceConfigValid ?? true,
    configPath,
    stateDirExistedAtStart: true,
    runWithPluginMetadataSnapshot: configResult.runWithPluginMetadataSnapshot,
    invalidatePluginMetadataSnapshot: configResult.invalidatePluginMetadataSnapshot,
  };
  await runInitialConfigWriteHealth(ctx);
  return configResult;
}

describe("Doctor legacy config composition", () => {
  afterEach(() => closeOpenClawStateDatabaseForTest());

  it.each([
    "list",
    "entries",
    "included list",
    "included entries",
    "list with env agent id",
    "list with config env",
  ])("preserves memory search settings from %s", async (shape) => {
    await withTempHome(async (home) => {
      await withEnvOverride(
        {
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          DOCTOR_AGENT_ID: "research",
          DOCTOR_MEMORY_KEY: shape === "list with config env" ? undefined : "memory-secret-canary",
        },
        async () => {
          const entries = {
            ops: {
              memorySearch: { enabled: false, provider: "openai", query: { maxResults: 7 } },
            },
            research: {
              memorySearch: {
                enabled: true,
                provider: "gemini",
                extraPaths: ["notes"],
                remote: { apiKey: "${DOCTOR_MEMORY_KEY}" },
              },
            },
          };
          const agents = {
            ownership: "explicit",
            ...(shape.endsWith("entries")
              ? { entries }
              : {
                  list: Object.entries(entries).map(([id, entry]) =>
                    Object.assign(
                      {
                        id:
                          shape === "list with env agent id" && id === "research"
                            ? "${DOCTOR_AGENT_ID}"
                            : id,
                      },
                      entry,
                    ),
                  ),
                }),
          };
          const included = shape.startsWith("included");
          const configPath = await writeOpenClawConfig(home, {
            agents: included ? { $include: "agents.json" } : agents,
            gateway: { mode: "local" },
            plugins: { enabled: false },
            ...(shape === "list with config env"
              ? { env: { vars: { DOCTOR_MEMORY_KEY: "memory-secret-canary" } } }
              : {}),
          });
          const includePath = path.join(path.dirname(configPath), "agents.json");
          if (included) {
            await fs.writeFile(includePath, JSON.stringify(agents));
          }
          const before = await readConfigFileSnapshot();
          expect(before.valid).toBe(false);
          expect(before.sourceConfig.agents).not.toHaveProperty("list");
          const repaired = await repairConfig(configPath);
          expect(repaired.cfg.agents?.entries?.research?.memory?.search?.remote?.apiKey).toBe(
            "memory-secret-canary",
          );
          const savedRoot = JSON.parse(await fs.readFile(configPath, "utf8"));
          if (included) {
            expect(savedRoot.agents).toEqual({ $include: "agents.json" });
          }
          const saved = {
            agents: included
              ? JSON.parse(await fs.readFile(includePath, "utf8"))
              : savedRoot.agents,
          };
          for (const [id, entry] of Object.entries(entries)) {
            expect(saved.agents.entries[id].memory?.search).toEqual(entry.memorySearch);
            expect(saved.agents.entries[id]).not.toHaveProperty("memorySearch");
          }
          expect(saved.agents.ownership).toBe("explicit");
          const reread = await readConfigFileSnapshot();
          expect(reread.valid).toBe(true);
          expect(
            reread.sourceConfig.agents?.entries?.research?.memory?.search?.remote?.apiKey,
          ).toBe("memory-secret-canary");
          expect((await repairConfig(configPath)).shouldWriteConfig).toBe(false);
        },
      );
    });
  });

  it.each(["root", "list", "entries"])("preserves message policy from %s", async (scope) => {
    await withTempHome(async (home) => {
      await withEnvOverride({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        const message = { allowCrossContextSend: true, broadcast: { enabled: false } };
        const agent = scope === "root" ? {} : { tools: { message } };
        const configPath = await writeOpenClawConfig(home, {
          agents:
            scope === "list" ? { list: [{ id: "ops", ...agent }] } : { entries: { ops: agent } },
          ...(scope === "root" ? { tools: { message } } : {}),
          gateway: { mode: "local" },
          plugins: { enabled: false },
        });
        expect((await readConfigFileSnapshot()).valid).toBe(false);
        await repairConfig(configPath);
        const saved = JSON.parse(await fs.readFile(configPath, "utf8"));
        const owner = scope === "root" ? saved : saved.agents.entries.ops;
        expect(owner.tools.message).toEqual({
          broadcast: { enabled: false },
          crossContext: { allowWithinProvider: true, allowAcrossProviders: true },
        });
        expect((await readConfigFileSnapshot()).valid).toBe(true);
        expect((await repairConfig(configPath)).shouldWriteConfig).toBe(false);
      });
    });
  });
  it("preserves inherited message policy when an agent opts out of the legacy bypass", async () => {
    await withTempHome(async (home) => {
      await withEnvOverride({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        const configPath = await writeOpenClawConfig(home, {
          tools: { message: { allowCrossContextSend: true } },
          agents: {
            ownership: "explicit",
            entries: {
              restricted: { tools: { message: { allowCrossContextSend: false } } },
              inherited: {},
            },
          },
          gateway: { mode: "local" },
          plugins: { enabled: false },
        });
        await repairConfig(configPath);
        const saved = JSON.parse(await fs.readFile(configPath, "utf8"));
        expect(saved.agents.entries.restricted.tools.message).toEqual({
          crossContext: { allowWithinProvider: true, allowAcrossProviders: false },
        });
        expect(saved.tools.message).toEqual({
          crossContext: { allowWithinProvider: true, allowAcrossProviders: true },
        });
        expect((await readConfigFileSnapshot()).valid).toBe(true);
        expect((await repairConfig(configPath)).shouldWriteConfig).toBe(false);
      });
    });
  });
  it.each(["${DOCTOR_MEMORY_KEY}", "$${DOCTOR_MEMORY_KEY}"])(
    "preserves migrated default memory references %s and explicit canonical values",
    async (apiKey) => {
      await withTempHome(async (home) => {
        await withEnvOverride(
          { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1", DOCTOR_MEMORY_KEY: "memory-secret-canary" },
          async () => {
            const configPath = await writeOpenClawConfig(home, {
              memory: { search: { enabled: false, query: { maxResults: 9 } } },
              agents: {
                defaults: {
                  memorySearch: {
                    enabled: true,
                    provider: "auto",
                    query: { maxResults: 7 },
                    remote: { apiKey },
                  },
                },
                entries: {
                  ops: {
                    memorySearch: { enabled: true, provider: "auto", query: { maxResults: 3 } },
                    memory: { search: { enabled: false, query: { maxResults: 5 } } },
                  },
                },
              },
              gateway: { mode: "local" },
              plugins: { enabled: false },
            });
            const repaired = await repairConfig(configPath);
            expect(repaired.cfg.memory?.search?.remote?.apiKey).toBe(
              apiKey.startsWith("$$") ? "${DOCTOR_MEMORY_KEY}" : "memory-secret-canary",
            );
            const saved = JSON.parse(await fs.readFile(configPath, "utf8"));
            expect(saved.memory.search).toEqual({
              enabled: false,
              provider: "openai",
              query: { maxResults: 9 },
              remote: { apiKey },
            });
            expect(saved.agents.defaults).not.toHaveProperty("memorySearch");
            expect(saved.agents.entries.ops.memory.search).toEqual({
              enabled: false,
              provider: "openai",
              query: { maxResults: 5 },
            });
            expect(saved.agents.entries.ops).not.toHaveProperty("memorySearch");
            expect((await readConfigFileSnapshot()).valid).toBe(true);
            expect((await repairConfig(configPath)).shouldWriteConfig).toBe(false);
          },
        );
      });
    },
  );

  it.each([true, false])(
    "preserves the shipped message bypass precedence for root %s",
    async (globalBypass) => {
      await withTempHome(async (home) => {
        await withEnvOverride({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
          const denied = { allowWithinProvider: false, allowAcrossProviders: false };
          const configPath = await writeOpenClawConfig(home, {
            tools: { message: { allowCrossContextSend: globalBypass, crossContext: denied } },
            agents: {
              ownership: "explicit",
              entries: {
                restricted: { tools: { message: { allowCrossContextSend: false } } },
                allowed: {
                  tools: {
                    message: {
                      allowCrossContextSend: true,
                      crossContext: { ...denied, marker: { enabled: false } },
                    },
                  },
                },
                inherited: { tools: { message: { crossContext: denied } } },
              },
            },
            gateway: { mode: "local" },
            plugins: { enabled: false },
          });
          await repairConfig(configPath);
          const snapshot = await readConfigFileSnapshot();
          expect(snapshot.valid).toBe(true);
          const { resolveEffectiveMessageToolsConfig } =
            await import("../infra/outbound/outbound-policy.js");
          const effective = (agentId: string) =>
            resolveEffectiveMessageToolsConfig({ cfg: snapshot.config, agentId });
          expect(effective("restricted")?.crossContext).toMatchObject(denied);
          expect(effective("allowed")?.crossContext).toEqual({
            allowWithinProvider: true,
            allowAcrossProviders: true,
            marker: { enabled: false },
          });
          expect(effective("inherited")?.crossContext).toEqual({
            allowWithinProvider: globalBypass,
            allowAcrossProviders: globalBypass,
          });
          expect(await fs.readFile(configPath, "utf8")).not.toContain("allowCrossContextSend");
          expect((await repairConfig(configPath)).shouldWriteConfig).toBe(false);
        });
      });
    },
  );
});
