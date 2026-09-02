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
  return { ...configResult, configWriteRefusal: ctx.configWriteRefusal };
}

describe("Doctor legacy config composition", () => {
  afterEach(() => closeOpenClawStateDatabaseForTest());

  it.each([
    "list",
    "entries",
    "included list",
    "included entries",
    "list with env agent id",
    "list with normalized agent id",
    "list with config env",
    "list with included identity",
  ])("preserves memory search settings from %s", async (shape) => {
    await withTempHome(async (home) => {
      await withEnvOverride(
        {
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          DOCTOR_AGENT_ID: "research",
          DOCTOR_TOOL: "read",
          DOCTOR_AGENT_WORKSPACE: path.join(home, "agent-workspace"),
          DOCTOR_MEMORY_KEY: shape === "list with config env" ? undefined : "memory-secret-canary",
        },
        async () => {
          const includedIdentity = shape === "list with included identity";
          const normalizedId = shape === "list with normalized agent id";
          const identityRaw =
            '{\n   "name": "${DOCTOR_AGENT_ID}",\n   "theme": "$${DOCTOR_MEMORY_KEY}"\n}\n';
          const toolsRaw = '{\n   "deny": ["browser"]\n}\n';
          const entries = {
            ops: {
              memorySearch: { enabled: false, provider: "openai", query: { maxResults: 7 } },
            },
            research: {
              workspace: "${DOCTOR_AGENT_WORKSPACE}",
              ...(includedIdentity
                ? {
                    identity: { $include: "identity.json" },
                    tools: { $include: "tools.json", allow: ["${DOCTOR_TOOL}"] },
                  }
                : {}),
              memorySearch: {
                enabled: true,
                provider: "gemini",
                extraPaths: ["notes"],
                remote: { apiKey: "${DOCTOR_MEMORY_KEY}" },
              },
            },
          };
          const agents = {
            ...(includedIdentity ? {} : { ownership: "explicit" }),
            ...(shape.endsWith("entries")
              ? { entries }
              : {
                  list: Object.entries(entries).map(([id, entry]) =>
                    Object.assign(
                      {
                        id:
                          shape === "list with env agent id" && id === "research"
                            ? "${DOCTOR_AGENT_ID}"
                            : normalizedId && id === "research"
                              ? "Research"
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
            gateway: normalizedId ? { $include: "gateway.json" } : { mode: "local" },
            plugins: { enabled: false },
            ...(shape === "list with config env"
              ? { env: { vars: { DOCTOR_MEMORY_KEY: "memory-secret-canary" } } }
              : {}),
          });
          const gatewayPath = path.join(path.dirname(configPath), "gateway.json");
          const gatewayRaw = '{\n   "mode": "local"\n}\n';
          if (normalizedId) {
            await fs.writeFile(gatewayPath, gatewayRaw);
          }
          const includePath = path.join(path.dirname(configPath), "agents.json");
          if (included) {
            await fs.writeFile(includePath, JSON.stringify(agents));
          }
          const identityPath = path.join(path.dirname(configPath), "identity.json");
          const toolsPath = path.join(path.dirname(configPath), "tools.json");
          if (includedIdentity) {
            await fs.writeFile(identityPath, identityRaw);
            await fs.writeFile(toolsPath, toolsRaw);
          }
          const before = await readConfigFileSnapshot();
          expect(before.valid).toBe(false);
          if (normalizedId) {
            expect(before.sourceConfig.agents).toHaveProperty("list");
          } else {
            expect(before.sourceConfig.agents).not.toHaveProperty("list");
          }
          if (includedIdentity) {
            expect(before.sourceConfig.agents?.entries?.research?.tools).toEqual({
              deny: ["browser"],
              allow: ["read"],
            });
          }
          const repaired = await repairConfig(configPath);
          expect(repaired.cfg.agents?.entries?.research?.memory?.search?.remote?.apiKey).toBe(
            "memory-secret-canary",
          );
          const savedRootRaw = await fs.readFile(configPath, "utf8");
          const savedRoot = JSON.parse(savedRootRaw);
          if (normalizedId) {
            expect(savedRoot.gateway).toEqual({ $include: "gateway.json" });
            expect(await fs.readFile(gatewayPath, "utf8")).toBe(gatewayRaw);
          }
          if (included) {
            expect(savedRoot.agents).toEqual({ $include: "agents.json" });
          }
          const saved = {
            agents: included
              ? JSON.parse(await fs.readFile(includePath, "utf8"))
              : savedRoot.agents,
          };
          expect(saved.agents).not.toHaveProperty("list");
          if (includedIdentity) {
            expect(saved.agents.entries.research.identity).toEqual({ $include: "identity.json" });
            expect(saved.agents.entries.research.tools).toEqual({
              $include: "tools.json",
              allow: ["${DOCTOR_TOOL}"],
            });
            expect(await fs.readFile(identityPath, "utf8")).toBe(identityRaw);
            expect(await fs.readFile(toolsPath, "utf8")).toBe(toolsRaw);
          }
          for (const [id, entry] of Object.entries(entries)) {
            expect(saved.agents.entries[id].memory?.search).toEqual(entry.memorySearch);
            expect(saved.agents.entries[id]).not.toHaveProperty("memorySearch");
          }
          expect(saved.agents.ownership).toBe("explicit");
          const reread = await readConfigFileSnapshot();
          expect(reread.valid).toBe(true);
          if (shape === "list") {
            expect(repaired.sourceConfigValid).toBe(true);
          }
          expect(saved.agents.entries.research.workspace).toBe("${DOCTOR_AGENT_WORKSPACE}");
          expect(reread.sourceConfig.agents?.entries?.research?.workspace).toBe(
            path.join(home, "agent-workspace"),
          );
          expect(
            reread.sourceConfig.agents?.entries?.research?.memory?.search?.remote?.apiKey,
          ).toBe("memory-secret-canary");
          if (includedIdentity) {
            expect(reread.sourceConfig.agents?.entries?.research?.identity).toEqual({
              name: "research",
              theme: "${DOCTOR_MEMORY_KEY}",
            });
            expect(reread.sourceConfig.agents?.entries?.research?.tools).toEqual({
              deny: ["browser"],
              allow: ["read"],
            });
          }
          expect((await repairConfig(configPath)).shouldWriteConfig).toBe(false);
          if (normalizedId) {
            expect(await fs.readFile(configPath, "utf8")).toBe(savedRootRaw);
            expect(await fs.readFile(gatewayPath, "utf8")).toBe(gatewayRaw);
          }
          if (includedIdentity) {
            expect(await fs.readFile(configPath, "utf8")).toBe(savedRootRaw);
            expect(await fs.readFile(identityPath, "utf8")).toBe(identityRaw);
            expect(await fs.readFile(toolsPath, "utf8")).toBe(toolsRaw);
          }
        },
      );
    });
  });

  it.each(["unnamed", "duplicate", "malformed"])(
    "repairs %s local agents beside an unrelated include",
    async (shape) => {
      await withTempHome(async (home) => {
        const workspace = path.join(home, "shared-agent-workspace");
        await withEnvOverride(
          {
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
            DOCTOR_TRUSTED_PROXY: "127.0.0.2",
            FIRST_WORKSPACE: workspace,
            SECOND_WORKSPACE: workspace,
          },
          async () => {
            const first = {
              name: "First agent",
              workspace: "${FIRST_WORKSPACE}",
              memorySearch: { enabled: false, query: { maxResults: 7 } },
            };
            const second = {
              name: "Second agent",
              workspace: "${SECOND_WORKSPACE}",
              memorySearch: { enabled: true, query: { maxResults: 9 } },
            };
            const expectedEntries: Record<string, typeof first> =
              shape === "unnamed"
                ? { agent: first }
                : shape === "duplicate"
                  ? { research: first, "research-2": second }
                  : { research: first };
            const configPath = await writeOpenClawConfig(home, {
              agents: {
                list:
                  shape === "unnamed"
                    ? [first]
                    : shape === "duplicate"
                      ? [
                          { id: "Research", ...first },
                          { id: "Research", ...second },
                        ]
                      : [null, { id: "Research", ...first }],
              },
              gateway: { $include: "gateway.json", trustedProxies: ["${DOCTOR_TRUSTED_PROXY}"] },
              plugins: { enabled: false },
            });
            const includePath = path.join(path.dirname(configPath), "gateway.json");
            const includeRaw = '{\n   "mode": "local",\n   "trustedProxies": ["127.0.0.1"]\n}\n';
            await fs.writeFile(includePath, includeRaw);
            expect((await readConfigFileSnapshot()).valid).toBe(false);
            await repairConfig(configPath);
            const savedRaw = await fs.readFile(configPath, "utf8");
            const saved = JSON.parse(savedRaw);
            expect(saved.agents).not.toHaveProperty("list");
            expect(Object.keys(saved.agents.entries)).toEqual(Object.keys(expectedEntries));
            for (const [id, entry] of Object.entries(expectedEntries)) {
              expect(saved.agents.entries[id]).toMatchObject({
                name: entry.name,
                workspace: entry.workspace,
                memory: { search: entry.memorySearch },
              });
              expect(saved.agents.entries[id]).not.toHaveProperty("memorySearch");
            }
            expect(saved.gateway).toEqual({
              $include: "gateway.json",
              trustedProxies: ["${DOCTOR_TRUSTED_PROXY}"],
            });
            expect(await fs.readFile(includePath, "utf8")).toBe(includeRaw);
            const reread = await readConfigFileSnapshot();
            expect(reread.valid).toBe(true);
            expect(reread.sourceConfig.gateway?.trustedProxies).toEqual(["127.0.0.1", "127.0.0.2"]);
            for (const [id, entry] of Object.entries(expectedEntries)) {
              expect(reread.sourceConfig.agents?.entries?.[id]?.workspace).toBe(workspace);
              expect(reread.sourceConfig.agents?.entries?.[id]?.memory?.search).toEqual(
                entry.memorySearch,
              );
            }
            expect((await repairConfig(configPath)).shouldWriteConfig).toBe(false);
            expect(await fs.readFile(configPath, "utf8")).toBe(savedRaw);
            expect(await fs.readFile(includePath, "utf8")).toBe(includeRaw);
          },
        );
      });
    },
  );

  it.each(["duplicate ids", "whole-entry include"])(
    "refuses ambiguous legacy roster persistence for %s",
    async (shape) => {
      await withTempHome(async (home) => {
        await withEnvOverride({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
          const identity = { name: "Second agent" };
          const includeRaw = `${JSON.stringify(
            shape === "duplicate ids" ? identity : { identity, memorySearch: { enabled: false } },
            null,
            3,
          )}\n`;
          const configPath = await writeOpenClawConfig(home, {
            agents: {
              list:
                shape === "duplicate ids"
                  ? [
                      { id: "worker", name: "First agent" },
                      {
                        id: "worker",
                        name: "Second agent",
                        identity: { $include: "included.json" },
                      },
                    ]
                  : [{ id: "worker", $include: "included.json" }],
              ...(shape === "duplicate ids"
                ? { defaults: { memorySearch: { enabled: false } } }
                : {}),
            },
            gateway: { mode: "local" },
            plugins: { enabled: false },
          });
          const includePath = path.join(path.dirname(configPath), "included.json");
          await fs.writeFile(includePath, includeRaw);
          const rootRaw = await fs.readFile(configPath, "utf8");
          expect((await readConfigFileSnapshot()).valid).toBe(false);
          const refusal = await repairConfig(configPath).then(
            (result) => result.configWriteRefusal,
            (error: unknown) => {
              expect(error).toMatchObject({ message: expect.stringContaining("$include-owned") });
              return "include-ownership";
            },
          );
          expect(["validation", "include-ownership"]).toContain(refusal);
          expect(await fs.readFile(configPath, "utf8")).toBe(rootRaw);
          expect(await fs.readFile(includePath, "utf8")).toBe(includeRaw);
          expect((await readConfigFileSnapshot()).valid).toBe(false);
        });
      });
    },
  );

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
