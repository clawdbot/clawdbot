import { beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../../../packages/gateway-client/src/request-error.js";
import {
  captureAgentPluginRuntimeRefresh,
  createAgentPluginRuntimeRefresh,
} from "../plugin-runtime-refresh.js";
import { callAgentToolGatewayRequest } from "./in-process-gateway.js";
import { createPluginsTool } from "./plugins-tool.js";

vi.mock("./in-process-gateway.js", () => ({ callAgentToolGatewayRequest: vi.fn() }));

const callGateway = vi.mocked(callAgentToolGatewayRequest);
const runtime = { operationId: "reload-1", generation: 2, pluginIds: ["local-tool"] };

describe("plugins tool", () => {
  beforeEach(() => {
    callGateway.mockReset();
  });

  it.each([
    {
      args: { action: "reload", pluginId: "local-tool" },
      method: "plugins.reload",
      params: { pluginId: "local-tool" },
    },
    {
      args: { action: "enable", pluginId: "local-tool" },
      method: "plugins.setEnabled",
      params: { pluginId: "local-tool", enabled: true },
    },
    {
      args: { action: "disable", pluginId: "local-tool" },
      method: "plugins.setEnabled",
      params: { pluginId: "local-tool", enabled: false },
    },
    {
      args: { action: "uninstall", pluginId: "local-tool" },
      method: "plugins.uninstall",
      params: { pluginId: "local-tool" },
    },
    {
      args: { action: "install", source: "local", path: "/plugins/local-tool", link: true },
      method: "plugins.install",
      params: { source: "local", path: "/plugins/local-tool", link: true },
    },
    {
      args: { action: "install", source: "official", pluginId: "local-tool" },
      method: "plugins.install",
      params: { source: "official", pluginId: "local-tool" },
    },
    {
      args: { action: "install", source: "official", pluginId: "local-tool", version: "1.0.0" },
      method: "plugins.install",
      params: { source: "official", pluginId: "local-tool", version: "1.0.0" },
    },
    {
      args: { action: "install", source: "clawhub", packageName: "local-tool", version: "1.0.0" },
      method: "plugins.install",
      params: { source: "clawhub", packageName: "local-tool", version: "1.0.0" },
    },
  ])(
    "routes $args.action through the authorized management owner",
    async ({ args, method, params }) => {
      callGateway.mockResolvedValue({ runtime, restartRequired: false });
      const refresh = createAgentPluginRuntimeRefresh();
      const signal = new AbortController().signal;
      await refresh.run(async () => {
        const tool = createPluginsTool();
        const result = await tool.execute("management", args, signal);
        expect(callGateway).toHaveBeenCalledExactlyOnceWith({
          method,
          params,
          signal,
          timeoutMs: null,
        });
        expect(result).toMatchObject({
          details: { runtime, restartRequired: false },
          terminate: true,
        });
        await expect(tool.execute("stale", args, signal)).rejects.toThrow("Plugin runtime changed");
        expect(callGateway).toHaveBeenCalledOnce();
      });
      refresh.close();
    },
  );

  it("retains capability review details without scheduling refresh after rejection", async () => {
    const details = { capabilityConsent: { reviewToken: "review-1", pluginId: "local-tool" } };
    callGateway
      .mockRejectedValueOnce(
        new GatewayClientRequestError({
          code: "INVALID_REQUEST",
          message: "Review the declared capability change",
          details,
        }),
      )
      .mockResolvedValueOnce({ runtime, restartRequired: false });
    const refresh = createAgentPluginRuntimeRefresh();
    await refresh.run(async () => {
      const owner = captureAgentPluginRuntimeRefresh();
      const tool = createPluginsTool();
      const result = await tool.execute("review", { action: "reload", pluginId: "local-tool" });
      expect(result).toMatchObject({
        isError: true,
        details: { code: "INVALID_REQUEST", details },
      });
      expect(result.terminate).toBeUndefined();
      expect(owner.isPending()).toBe(false);
      await tool.execute("approved", {
        action: "reload",
        pluginId: "local-tool",
        reviewToken: "review-1",
      });
      expect(callGateway).toHaveBeenLastCalledWith(
        expect.objectContaining({
          params: { pluginId: "local-tool", acknowledgeCapabilities: { reviewToken: "review-1" } },
        }),
      );
      expect(owner.isPending()).toBe(true);
    });
    refresh.close();
  });

  it.each([false, true])(
    "refreshes after a failed mutation only if publication committed (%s)",
    async (committed) => {
      const details = { runtime: { ...runtime, phase: "activate", committed } };
      callGateway.mockRejectedValue(
        new GatewayClientRequestError({
          code: "UNAVAILABLE",
          message: "Plugin service activation failed",
          details,
        }),
      );
      const refresh = createAgentPluginRuntimeRefresh();
      await refresh.run(async () => {
        const owner = captureAgentPluginRuntimeRefresh();
        const result = await createPluginsTool().execute("failed", {
          action: "reload",
          pluginId: "local-tool",
        });
        expect(result).toMatchObject({
          isError: true,
          details: { error: "Plugin service activation failed", details },
        });
        expect(result.terminate === true).toBe(committed);
        expect(owner.isPending()).toBe(committed);
      });
      refresh.close();
    },
  );

  it("keeps old callback closures fenced after another generation is admitted", async () => {
    const refresh = createAgentPluginRuntimeRefresh();
    callGateway.mockResolvedValue({ runtime });
    const oldTool = refresh.run(() => createPluginsTool());
    refresh.takeContinuation();
    await refresh.run(async () => {
      await expect(
        oldTool.execute("stale", { action: "reload", pluginId: "local-tool" }),
      ).rejects.toThrow("Plugin runtime changed");
      expect(callGateway).not.toHaveBeenCalled();
      const nextTool = createPluginsTool();
      await expect(
        nextTool.execute("current", { action: "reload", pluginId: "local-tool" }),
      ).resolves.toMatchObject({ terminate: true });
    });
    refresh.close();
  });

  it.each([
    {
      action: "inspect",
      payload: {
        ok: true,
        declared: { tools: Array.from({ length: 600 }, () => "x") },
        reviewToken: "complete-review-only",
      },
    },
    {
      action: "search",
      payload: { results: [{ package: { name: "large", summary: "🦞".repeat(2_000) } }] },
    },
  ])(
    "bounds the complete $action result without exposing a partial review",
    async ({ action, payload }) => {
      callGateway.mockResolvedValue(payload);
      const result = await createPluginsTool().execute("large-result", {
        action,
        pluginId: "local-tool",
        query: "large",
      });
      expect(result).toMatchObject({
        details: { ok: true, detailsOmitted: "response_budget_exceeded" },
        content: [{ type: "text", text: JSON.stringify(result.details, null, 2) }],
      });
      expect(
        Buffer.byteLength(JSON.stringify(result.details, null, 2), "utf8"),
      ).toBeLessThanOrEqual(3_840);
      expect(JSON.stringify(result)).not.toContain("complete-review-only");
      expect(result.terminate).toBeUndefined();
    },
  );

  it.each([undefined, false, true])(
    "retains the publication outcome and continuation when mutation details exceed the budget (%s)",
    async (committed) => {
      const application = {
        ...runtime,
        ...(committed === undefined ? {} : { committed, phase: "activate" }),
      };
      const oversized = { warnings: ["detail".repeat(2_000)] };
      if (committed === undefined) {
        callGateway.mockResolvedValue({ ok: true, runtime: application, ...oversized });
      } else {
        callGateway.mockRejectedValue(
          new GatewayClientRequestError({
            code: "UNAVAILABLE",
            message: "Activation failed",
            details: {
              runtime: application,
              ...oversized,
              capabilityConsent: { reviewToken: "complete-review-only" },
            },
          }),
        );
      }
      const refresh = createAgentPluginRuntimeRefresh();
      try {
        await refresh.run(async () => {
          const owner = captureAgentPluginRuntimeRefresh();
          const result = await createPluginsTool().execute("large-mutation", {
            action: "reload",
            pluginId: "local-tool",
          });
          expect(result).toMatchObject({
            details: {
              ok: committed === undefined,
              runtime: { generation: runtime.generation, committed: committed ?? true },
              detailsOmitted: "response_budget_exceeded",
            },
            content: [{ type: "text", text: JSON.stringify(result.details, null, 2) }],
          });
          if (committed !== undefined) {
            expect(result).toMatchObject({
              isError: true,
              details: { runtime: { phase: "activate" } },
            });
          }
          expect(
            Buffer.byteLength(JSON.stringify(result.details, null, 2), "utf8"),
          ).toBeLessThanOrEqual(3_840);
          expect(JSON.stringify(result)).not.toContain("complete-review-only");
          expect(result.terminate === true).toBe(committed ?? true);
          expect(owner.isPending()).toBe(committed ?? true);
        });
      } finally {
        refresh.close();
      }
    },
  );

  it("bounds inventory and narrows it without hiding the omitted count", async () => {
    const plugins = Array.from({ length: 25 }, (_, index) => ({
      id: `plugin-${index}`,
      name: `Plugin ${index}`,
      description: "runtime detail",
      version: "1.0.0",
      state: "enabled",
    }));
    callGateway.mockResolvedValue({ plugins, mutationAllowed: true });
    const tool = createPluginsTool();
    const all = await tool.execute("inventory", { action: "list" });
    expect(all.details).toMatchObject({ matching: 25, omitted: 5, mutationAllowed: true });
    expect((all.details as { plugins: unknown[] }).plugins).toHaveLength(20);
    const narrowed = await tool.execute("filter", { action: "list", query: "plugin-24" });
    expect(narrowed.details).toMatchObject({
      plugins: [{ id: "plugin-24", state: "enabled", version: "1.0.0" }],
      matching: 1,
      omitted: 0,
    });
  });
});
