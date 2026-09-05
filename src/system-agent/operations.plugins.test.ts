import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import {
  expectAuditRecord,
  expectRecordFields,
  mockConfig,
  opTempDirs,
  pluginLifecycleMocks,
  readLastAuditEntry,
  useSystemAgentOperationsTestHarness,
} from "./operations.test-support.js";

// Shared mocks must register before loading the real operation owners.
const { ManagedPluginLifecycleError } = await import("../plugins/management-lifecycle-error.js");
const { setTestEnvValue } = await import("../test-utils/env.js");
const { executeSystemAgentOperation } = await import("./operations.js");
const { createSystemAgentTestRuntime } = await import("./system-agent.runtime.test-support.js");

describe("system agent operations", () => {
  useSystemAgentOperationsTestHarness();

  it("runs plugin list and search as read-only operations", async () => {
    const { runtime, lines } = createSystemAgentTestRuntime();
    const runPluginsList = vi.fn(async (pluginRuntime: RuntimeEnv) => {
      pluginRuntime.log("plugin rows");
    });
    const runPluginsSearch = vi.fn(async (query: string, pluginRuntime: RuntimeEnv) => {
      pluginRuntime.log(`search rows: ${query}`);
    });

    const listResult = await executeSystemAgentOperation({ kind: "plugin-list" }, runtime, {
      deps: { runPluginsList, runPluginsSearch },
    });
    expect(listResult.applied).toBe(false);
    const searchResult = await executeSystemAgentOperation(
      { kind: "plugin-search", query: "calendar" },
      runtime,
      {
        deps: { runPluginsList, runPluginsSearch },
      },
    );
    expect(searchResult.applied).toBe(false);

    expect(runPluginsList).toHaveBeenCalledWith(runtime);
    expect(runPluginsSearch).toHaveBeenCalledWith("calendar", runtime);
    expect(lines.join("\n")).toContain("plugin rows");
    expect(lines.join("\n")).toContain("search rows: calendar");
  });

  it.each(["live", "closed"] as const)(
    "installs plugins only with %s delegated authority and audits successful writes",
    async (authority) => {
      const tempDir = opTempDirs.make("openclaw-plugin-install-");
      setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
      const { runtime, lines } = createSystemAgentTestRuntime();
      const applied: string[] = [];
      let authorityOpen = true;
      const beforePersistentApply = vi.fn(() => {
        if (!authorityOpen) {
          throw new Error("delegated authority closed");
        }
      });
      const applyPluginRuntime = vi.fn(async () => ({
        operationId: "install",
        generation: 4,
        pluginIds: ["openclaw-demo"],
      }));
      pluginLifecycleMocks.install.mockImplementation(
        async (
          params: Parameters<
            typeof import("../plugins/management-mutations.js").installManagedPlugin
          >[0],
        ) => {
          await Promise.resolve();
          if (authority === "closed") {
            authorityOpen = false;
          }
          params.beforePersistentApply?.();
          applied.push("openclaw-demo");
          return {
            plugin: { id: "openclaw-demo" },
            application: await params.applyRuntime?.({
              config: {},
              pluginIds: ["openclaw-demo"],
              reason: "install",
            }),
          };
        },
      );

      const plan = await executeSystemAgentOperation(
        { kind: "plugin-install", spec: "clawhub:openclaw-demo" },
        runtime,
      );
      expect(plan).toMatchObject({
        applied: false,
        message: "Plan: install plugin clawhub:openclaw-demo. Say yes to apply.",
      });
      expect(pluginLifecycleMocks.install).not.toHaveBeenCalled();

      const pending = executeSystemAgentOperation(
        { kind: "plugin-install", spec: "clawhub:openclaw-demo" },
        runtime,
        {
          approved: true,
          beforePersistentApply,
          applyPluginRuntime,
          auditDetails: { rescue: true },
        },
      );
      if (authority === "closed") {
        await expect(pending).rejects.toThrow("delegated authority closed");
        expect(applied).toEqual([]);
        expect(applyPluginRuntime).not.toHaveBeenCalled();
        expect(readLastAuditEntry()).toBeUndefined();
        expect(lines.join("\n")).not.toContain("[openclaw] done: plugin.install");
      } else {
        await expect(pending).resolves.toMatchObject({ applied: true });
        expect(applied).toEqual(["openclaw-demo"]);
        expect(applyPluginRuntime).toHaveBeenCalledExactlyOnceWith({
          config: {},
          pluginIds: ["openclaw-demo"],
          reason: "install",
        });
        expect(lines.join("\n")).toContain(
          "Installed plugin openclaw-demo in Gateway generation 4.",
        );
        expect(lines.join("\n")).toContain("[openclaw] done: plugin.install");
        expectAuditRecord(
          readLastAuditEntry(),
          { operation: "plugin.install", summary: "Installed plugin clawhub:openclaw-demo" },
          { rescue: true, spec: "clawhub:openclaw-demo" },
        );
      }
      expect(pluginLifecycleMocks.install).toHaveBeenCalledWith({
        request: expect.objectContaining({
          source: "clawhub",
          packageName: "openclaw-demo",
          mode: "install",
        }),
        applyRuntime: expect.any(Function),
        beforePersistentApply,
      });
      expect(pluginLifecycleMocks.gateway).not.toHaveBeenCalled();
    },
  );

  it("rejects an invalid approved plugin spec without exiting inside the executor", async () => {
    mockConfig.readConfigFileSnapshot.mockClear();
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn() as unknown as RuntimeEnv["exit"],
    };

    await expect(
      executeSystemAgentOperation(
        { kind: "plugin-install", spec: "https://example.test/plugin.tgz" },
        runtime,
        { approved: true },
      ),
    ).rejects.toThrow("accepts npm or ClawHub package specs only");

    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(pluginLifecycleMocks.install).not.toHaveBeenCalled();
    expect(mockConfig.readConfigFileSnapshot).not.toHaveBeenCalled();
  });

  it("rejects arbitrary plugin sources before proposing or installing them", async () => {
    const { runtime } = createSystemAgentTestRuntime();

    // Untrusted spec must be rejected on the unapproved path too, so a
    // formatted "plan" never surfaces an arbitrary source for approval.
    await expect(
      executeSystemAgentOperation({ kind: "plugin-install", spec: "npm:@example/plugin" }, runtime),
    ).rejects.toThrow("trusted shell");
    expect(pluginLifecycleMocks.install).not.toHaveBeenCalled();
  });

  it.each(["live", "closed"] as const)(
    "uninstalls a non-route plugin only with %s delegated authority and audits successful writes",
    async (authority) => {
      const tempDir = opTempDirs.make("openclaw-plugin-uninstall-");
      setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
      const { runtime, lines } = createSystemAgentTestRuntime();
      let authorityOpen = true;
      const removed: string[] = [];
      const beforePersistentApply = () => {
        if (!authorityOpen) {
          throw new Error("delegated authority closed");
        }
      };
      const applyPluginRuntime = vi.fn(async () => ({
        operationId: "uninstall",
        generation: 5,
        pluginIds: ["openclaw-demo"],
      }));
      pluginLifecycleMocks.uninstall.mockImplementation(
        async (
          params: Parameters<
            typeof import("../plugins/management-mutations.js").uninstallManagedPlugin
          >[0],
        ) => {
          await Promise.resolve();
          if (authority === "closed") {
            authorityOpen = false;
          }
          params.beforePersistentApply?.();
          removed.push(params.pluginId);
          return {
            pluginId: params.pluginId,
            removed: ["directory"],
            application: await params.applyRuntime?.({
              config: {},
              pluginIds: [params.pluginId],
              reason: "uninstall",
            }),
          };
        },
      );
      const operation = { kind: "plugin-uninstall" as const, pluginId: "openclaw-demo" };
      const plan = await executeSystemAgentOperation(operation, runtime);
      expect(plan).toMatchObject({
        applied: false,
        message: "Plan: uninstall plugin openclaw-demo. Say yes to apply.",
      });
      expect(pluginLifecycleMocks.uninstall).not.toHaveBeenCalled();

      const pending = executeSystemAgentOperation(operation, runtime, {
        approved: true,
        beforePersistentApply,
        applyPluginRuntime,
      });
      if (authority === "closed") {
        await expect(pending).rejects.toThrow("delegated authority closed");
        expect(removed).toEqual([]);
        expect(readLastAuditEntry()).toBeUndefined();
        expect(lines.join("\n")).not.toContain("[openclaw] done: plugin.uninstall");
      } else {
        await expect(pending).resolves.toMatchObject({ applied: true });
        expect(removed).toEqual(["openclaw-demo"]);
        expect(applyPluginRuntime).toHaveBeenCalledExactlyOnceWith({
          config: {},
          pluginIds: ["openclaw-demo"],
          reason: "uninstall",
        });
        expect(lines.join("\n")).toContain(
          "Uninstalled plugin openclaw-demo in Gateway generation 5.",
        );
        expect(lines.join("\n")).toContain("[openclaw] done: plugin.uninstall");
        expectAuditRecord(
          readLastAuditEntry(),
          { operation: "plugin.uninstall", summary: "Uninstalled plugin openclaw-demo" },
          { pluginId: "openclaw-demo" },
        );
      }
      expect(pluginLifecycleMocks.uninstall).toHaveBeenCalledWith({
        pluginId: "openclaw-demo",
        applyRuntime: expect.any(Function),
        beforePersistentApply,
      });
      expect(pluginLifecycleMocks.gateway).not.toHaveBeenCalled();
    },
  );

  it.each([
    { action: "install", failureKind: "catalog" },
    { action: "install", failureKind: "authority" },
    { action: "uninstall", failureKind: "removal" },
    { action: "uninstall", failureKind: "authority" },
  ] as const)(
    "reports an applied $action generation while preserving the raw $failureKind failure",
    async ({ action, failureKind }) => {
      setTestEnvValue("OPENCLAW_STATE_DIR", opTempDirs.make("openclaw-plugin-partial-operation-"));
      const { runtime, lines } = createSystemAgentTestRuntime();
      const failure =
        failureKind === "authority"
          ? new Error("Delegated authority closed")
          : failureKind === "catalog"
            ? new ManagedPluginLifecycleError(
                "installed plugin missing from refreshed registry: openclaw-demo",
              )
            : new ManagedPluginLifecycleError("Directory removal failed; retry uninstall", {
                kind: "unavailable",
              });
      let authorityOpen = true;
      const beforePersistentApply = vi.fn(() => {
        if (!authorityOpen) {
          throw failure;
        }
      });
      const applyPluginRuntime = vi.fn(async () => ({
        operationId: "committed-plugin-operation",
        generation: 5,
        pluginIds: ["openclaw-demo"],
      }));
      const change = {
        config: { plugins: { entries: { "openclaw-demo": { enabled: action === "install" } } } },
        pluginIds: ["openclaw-demo"],
        reason: action,
      };
      const failAfterApply = async (
        params: Pick<
          Parameters<typeof import("../plugins/management-mutations.js").installManagedPlugin>[0],
          "applyRuntime" | "beforePersistentApply"
        >,
      ) => {
        expect(params.beforePersistentApply).toBe(beforePersistentApply);
        params.beforePersistentApply?.();
        await params.applyRuntime?.(change);
        if (failureKind === "authority") {
          authorityOpen = false;
          params.beforePersistentApply?.();
          throw new Error("Closed delegated authority did not reject the write");
        }
        throw failure;
      };
      pluginLifecycleMocks[action].mockImplementation(failAfterApply);
      const operation =
        action === "install"
          ? { kind: "plugin-install" as const, spec: "clawhub:openclaw-demo" }
          : { kind: "plugin-uninstall" as const, pluginId: "openclaw-demo" };

      await expect(
        executeSystemAgentOperation(operation, runtime, {
          approved: true,
          beforePersistentApply,
          applyPluginRuntime,
        }),
      ).rejects.toBe(failure);

      expect(applyPluginRuntime).toHaveBeenCalledExactlyOnceWith(change);
      expect(lines.join("\n")).toContain(
        `Plugin runtime changes were applied in Gateway generation 5; ${action} did not complete.`,
      );
      expect(lines.join("\n")).not.toContain(`[openclaw] done: plugin.${action}`);
      expect(readLastAuditEntry()).toBeUndefined();
      expect(pluginLifecycleMocks.gateway).not.toHaveBeenCalled();
    },
  );

  it.each(["proposal", "apply", "unrelated"] as const)(
    "checks all uninstall package entries against inference at %s",
    async (phase) => {
      setTestEnvValue("OPENCLAW_STATE_DIR", opTempDirs.make("openclaw-package-inference-"));
      mockConfig.setConfig({ agents: { defaults: { model: "openai/gpt-5.5" } } });
      const { runtime } = createSystemAgentTestRuntime();
      const runPluginUninstall = vi.fn(async () => {});
      const safe = { pluginId: "pack", pluginIds: ["pack/tools", "pack/other"] };
      const protectedPackage = { pluginId: "pack", pluginIds: ["pack/tools", "openai"] };
      pluginLifecycleMocks.planUninstall.mockResolvedValue(
        phase === "unrelated" ? safe : protectedPackage,
      );
      if (phase === "apply") {
        pluginLifecycleMocks.planUninstall.mockResolvedValueOnce(safe);
      }
      const pending = executeSystemAgentOperation(
        { kind: "plugin-uninstall", pluginId: "pack/tools" },
        runtime,
        { approved: true, deps: { runPluginUninstall } },
      );
      if (phase === "apply") {
        await expect(pending).rejects.toThrow("now backs the active inference route");
      } else {
        await expect(pending).resolves.toMatchObject({ applied: phase === "unrelated" });
      }
      if (phase === "unrelated") {
        expect(runPluginUninstall).toHaveBeenCalledOnce();
      } else {
        expect(runPluginUninstall).not.toHaveBeenCalled();
        expect(readLastAuditEntry()).toBeUndefined();
      }
    },
  );

  it("refuses plugin uninstall when it cannot prove inference survives", async () => {
    // Fail closed: without a readable config the route cannot be proven safe.
    mockConfig.missing("/tmp/openclaw.json");
    const { runtime, lines } = createSystemAgentTestRuntime();
    const runPluginUninstall = vi.fn();

    const result = await executeSystemAgentOperation(
      { kind: "plugin-uninstall", pluginId: "openclaw-demo" },
      runtime,
      { approved: true, deps: { runPluginUninstall } },
    );
    expectRecordFields(result as unknown as Record<string, unknown>, {
      applied: false,
    });
    expect(runPluginUninstall).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("could remove the provider behind");
    expect(lines.join("\n")).toContain("openclaw plugins uninstall openclaw-demo");
  });
});
