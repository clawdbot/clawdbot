import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withTempHomeConfig } from "../config/test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { markClawMcpServerIndependentlyOwned } from "../state/claw-mcp-adoption.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { setTestEnvValue } from "../test-utils/env.js";
import { applyClawAddPlan } from "./add.js";
import { quiescentClawMonitorGateway } from "./lifecycle-remove.test-support.js";
import { applyClawRemovePlan, buildClawRemovePlan } from "./lifecycle-state.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { installClawMcpServers } from "./mcp.js";
import { parseClawManifest } from "./schema.js";
import type { ClawSourceIdentity } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());

const sourceServer = {
  command: "uvx",
  args: ["docs-mcp"],
  env: { DOCS_TOKEN: "${DOCS_TOKEN}" },
};

async function addMcpFixture() {
  const root = tempDirs.make("openclaw-claw-remove-mcp-");
  const parsed = parseClawManifest({
    schemaVersion: 1,
    agent: { id: "worker", name: "Worker" },
    mcpServers: { docs: sourceServer },
  });
  if (!parsed.ok) {
    throw new Error(JSON.stringify(parsed.diagnostics));
  }
  const source: ClawSourceIdentity = {
    kind: "package",
    name: "@acme/worker",
    version: "1.0.0",
    packageRoot: root,
    manifestPath: join(root, "openclaw.claw.json"),
    integrityKind: "artifact",
    integrity: "sha256:manifest",
    byteLength: 100,
  };
  const plan = await buildClawAddPlan({
    manifest: parsed.manifest,
    source,
    context: { workspace: join(root, "workspace-worker") },
  });
  const env = { OPENCLAW_STATE_DIR: join(root, "state") };
  let config: OpenClawConfig = {};
  await applyClawAddPlan(plan, {
    consentPlanIntegrity: plan.planIntegrity,
    env,
    commitConfig: async (transform) => {
      config = transform(config);
    },
    installMcpServers: async () => [],
  });
  return {
    plan,
    env,
    getConfig: () => config,
  };
}

function listedMcpServers(
  config: OpenClawConfig,
  mcpServers: Record<string, Record<string, unknown>>,
) {
  return {
    ok: true as const,
    path: "config",
    config,
    mcpServers,
  };
}

async function recordManagedMcp(current: Awaited<ReturnType<typeof addMcpFixture>>) {
  await installClawMcpServers(current.plan, {
    env: current.env,
    setMcpServer: vi.fn().mockResolvedValue({ ok: true, path: "config", config: {} }),
    listMcpServers: vi.fn().mockResolvedValue(listedMcpServers({}, {})),
  });
}

describe("Claw MCP removal", () => {
  it("releases an exact pre-existing MCP server without deleting it", async () => {
    const current = await addMcpFixture();
    await installClawMcpServers(current.plan, {
      env: current.env,
      setMcpServer: vi.fn(),
      listMcpServers: vi.fn().mockResolvedValue(listedMcpServers({}, { docs: sourceServer })),
    });
    const config: OpenClawConfig = {
      ...current.getConfig(),
      mcp: { servers: { docs: sourceServer } },
    };
    const plan = await buildClawRemovePlan("worker", { env: current.env, config });
    const unsetMcpServer = vi.fn();

    const result = await withTempHomeConfig(config, async ({ configPath }) => {
      setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
      setTestEnvValue("OPENCLAW_STATE_DIR", current.env.OPENCLAW_STATE_DIR);
      const removed = await applyClawRemovePlan(plan, {
        monitorGateway: quiescentClawMonitorGateway,
        consentPlanIntegrity: plan.planIntegrity,
        env: current.env,
        config,
        unsetMcpServer,
        trashPath: async () => true,
      });
      expect(JSON.parse(await readFile(configPath, "utf8"))).toHaveProperty(
        "mcp.servers.docs",
        sourceServer,
      );
      return removed;
    });

    expect(unsetMcpServer).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "complete",
      agentRemoved: true,
      mcpServers: [{ name: "docs", action: "released" }],
    });
  });

  it("deletes the final unchanged Claw-created MCP server", async () => {
    const current = await addMcpFixture();
    await recordManagedMcp(current);
    const config: OpenClawConfig = {
      ...current.getConfig(),
      mcp: {
        servers: {
          docs: {
            ...sourceServer,
            env: { DOCS_TOKEN: "resolved-secret-must-not-affect-removal" },
          },
        },
      },
    };
    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config,
      sourceMcpServers: { docs: sourceServer },
    });
    const unsetMcpServer = vi
      .fn()
      .mockResolvedValue({ ok: true, path: "config", config: {}, mcpServers: {}, removed: true });

    const result = await withTempHomeConfig(config, async ({ configPath }) => {
      setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
      setTestEnvValue("OPENCLAW_STATE_DIR", current.env.OPENCLAW_STATE_DIR);
      return applyClawRemovePlan(plan, {
        monitorGateway: quiescentClawMonitorGateway,
        consentPlanIntegrity: plan.planIntegrity,
        env: current.env,
        config,
        sourceMcpServers: { docs: sourceServer },
        unsetMcpServer,
        trashPath: async () => true,
      });
    });

    expect(unsetMcpServer).toHaveBeenCalledWith({
      name: "docs",
      expectedServer: sourceServer,
      recordIndependentOwner: false,
    });
    expect(result).toMatchObject({
      status: "complete",
      agentRemoved: true,
      mcpServers: [{ name: "docs", action: "removed" }],
    });
  });

  it("releases missing managed MCP provenance without changing the remove plan", async () => {
    const current = await addMcpFixture();
    await recordManagedMcp(current);
    const config = current.getConfig();
    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config,
      sourceMcpServers: {},
    });

    const result = await withTempHomeConfig(config, async ({ configPath }) => {
      setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
      setTestEnvValue("OPENCLAW_STATE_DIR", current.env.OPENCLAW_STATE_DIR);
      return applyClawRemovePlan(plan, {
        monitorGateway: quiescentClawMonitorGateway,
        consentPlanIntegrity: plan.planIntegrity,
        env: current.env,
        config,
        sourceMcpServers: {},
        trashPath: async () => true,
      });
    });

    expect(result).toMatchObject({
      status: "complete",
      agentRemoved: true,
      mcpServers: [{ name: "docs", action: "missing" }],
    });
  });

  it("retains a managed MCP server adopted after remove planning", async () => {
    const current = await addMcpFixture();
    await recordManagedMcp(current);
    const config = current.getConfig();
    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config,
      sourceMcpServers: { docs: sourceServer },
    });
    markClawMcpServerIndependentlyOwned("docs", { env: current.env });
    const unsetMcpServer = vi.fn();

    await expect(
      withTempHomeConfig(config, async ({ configPath }) => {
        setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
        setTestEnvValue("OPENCLAW_STATE_DIR", current.env.OPENCLAW_STATE_DIR);
        return applyClawRemovePlan(plan, {
          monitorGateway: quiescentClawMonitorGateway,
          consentPlanIntegrity: plan.planIntegrity,
          env: current.env,
          config,
          sourceMcpServers: { docs: sourceServer },
          unsetMcpServer,
          trashPath: async () => true,
        });
      }),
    ).rejects.toMatchObject({ code: "remove_changed" });
    expect(unsetMcpServer).not.toHaveBeenCalled();
  });

  it("removes a managed MCP server restored while removal is applying", async () => {
    const current = await addMcpFixture();
    await recordManagedMcp(current);

    await withTempHomeConfig(current.getConfig(), async ({ configPath }) => {
      setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
      setTestEnvValue("OPENCLAW_STATE_DIR", current.env.OPENCLAW_STATE_DIR);
      const missing = listedMcpServers(current.getConfig(), {});
      const restored = listedMcpServers(
        { ...current.getConfig(), mcp: { servers: { docs: sourceServer } } },
        { docs: sourceServer },
      );
      const listMcpServers = vi
        .fn()
        .mockResolvedValueOnce(missing)
        .mockResolvedValueOnce(missing)
        .mockResolvedValueOnce(missing)
        .mockResolvedValueOnce(restored);
      const plan = await buildClawRemovePlan("worker", {
        env: current.env,
        listMcpServers,
      });
      const unsetMcpServer = vi
        .fn()
        .mockResolvedValue({ ok: true, path: "config", config: {}, mcpServers: {}, removed: true });
      const result = await applyClawRemovePlan(plan, {
        monitorGateway: quiescentClawMonitorGateway,
        consentPlanIntegrity: plan.planIntegrity,
        env: current.env,
        listMcpServers,
        unsetMcpServer,
        trashPath: async () => true,
      });

      expect(unsetMcpServer).toHaveBeenCalledWith({
        name: "docs",
        expectedServer: sourceServer,
        recordIndependentOwner: false,
      });
      expect(result).toMatchObject({
        status: "complete",
        agentRemoved: true,
        mcpServers: [{ name: "docs", action: "removed" }],
      });
    });
  });

  it("preserves a different MCP server restored while removal is applying", async () => {
    const current = await addMcpFixture();
    const replacementServer = { command: "node", args: ["replacement-mcp"] };
    await recordManagedMcp(current);

    await withTempHomeConfig(current.getConfig(), async ({ configPath }) => {
      setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
      setTestEnvValue("OPENCLAW_STATE_DIR", current.env.OPENCLAW_STATE_DIR);
      const missing = listedMcpServers(current.getConfig(), {});
      const restored = listedMcpServers(
        { ...current.getConfig(), mcp: { servers: { docs: replacementServer } } },
        { docs: replacementServer },
      );
      const listMcpServers = vi
        .fn()
        .mockResolvedValueOnce(missing)
        .mockResolvedValueOnce(missing)
        .mockResolvedValueOnce(missing)
        .mockResolvedValueOnce(restored);
      const plan = await buildClawRemovePlan("worker", {
        env: current.env,
        listMcpServers,
      });
      const unsetMcpServer = vi.fn();
      await expect(
        applyClawRemovePlan(plan, {
          monitorGateway: quiescentClawMonitorGateway,
          consentPlanIntegrity: plan.planIntegrity,
          env: current.env,
          listMcpServers,
          unsetMcpServer,
          trashPath: async () => true,
        }),
      ).resolves.toMatchObject({
        status: "partial",
        agentRemoved: false,
        error: { code: "mcp_cleanup_changed" },
      });
      expect(unsetMcpServer).not.toHaveBeenCalled();
    });
  });
});
