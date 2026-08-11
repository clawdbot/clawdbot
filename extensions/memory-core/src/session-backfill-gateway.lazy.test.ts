import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { expect, it, vi } from "vitest";
import { registerSessionBackfillGatewayMethods } from "./session-backfill-gateway.js";

const isLegacyMemorySurfaceDisabled = vi.hoisted(() => vi.fn(() => false));

vi.mock("openclaw/plugin-sdk/memory-core-host-runtime-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/memory-core-host-runtime-core")>()),
  isLegacyMemorySurfaceDisabled,
}));

const backfillModule = vi.hoisted(() => ({
  loadCount: 0,
  executeSessionBackfill: vi.fn(),
  executeSessionBackfillBatch: vi.fn(),
}));

vi.mock("./session-backfill.js", () => {
  backfillModule.loadCount += 1;
  return {
    executeSessionBackfill: backfillModule.executeSessionBackfill,
    executeSessionBackfillBatch: backfillModule.executeSessionBackfillBatch,
  };
});

it("loads session backfill execution only for the first valid request", async () => {
  const methods = new Map<string, (options: GatewayRequestHandlerOptions) => Promise<void>>();
  const api = {
    runtime: {
      config: {
        current: () => ({
          agents: {
            entries: { main: { default: true, workspace: "/tmp/main-workspace" } },
          },
        }),
      },
      agent: {
        resolveAgentWorkspaceDir: () => "/tmp/main-workspace",
      },
    },
    registerGatewayMethod(
      method: string,
      handler: (options: GatewayRequestHandlerOptions) => Promise<void>,
    ) {
      methods.set(method, handler);
    },
  } as unknown as OpenClawPluginApi;

  registerSessionBackfillGatewayMethods(api);
  expect(backfillModule.loadCount).toBe(0);

  const preview = methods.get("memory.sessionBackfill.preview");
  expect(preview).toBeDefined();
  const invalidRespond = vi.fn();
  await preview!({
    params: { agentId: "main", from: "invalid" },
    respond: invalidRespond,
  } as unknown as GatewayRequestHandlerOptions);
  expect(backfillModule.loadCount).toBe(0);
  expect(invalidRespond.mock.calls[0]?.[2]).toMatchObject({ code: "INVALID_REQUEST" });

  isLegacyMemorySurfaceDisabled.mockReturnValue(true);
  const cutoverRespond = vi.fn();
  await preview!({
    params: { agentId: "main" },
    respond: cutoverRespond,
  } as unknown as GatewayRequestHandlerOptions);
  expect(backfillModule.loadCount).toBe(0);
  expect(cutoverRespond.mock.calls[0]?.[2]).toMatchObject({ code: "UNAVAILABLE" });

  isLegacyMemorySurfaceDisabled.mockReturnValue(false);

  backfillModule.executeSessionBackfillBatch.mockResolvedValue({
    result: {
      agentId: "main",
      workspaceDir: "/tmp/main-workspace",
      applied: false,
      rem: false,
      days: [],
      candidateCount: 0,
      stagedEntries: 0,
      writtenDiaryEntries: 0,
      replacedDiaryEntries: 0,
    },
    continuation: { advanced: false, hasMore: false },
  });
  await preview!({
    params: { agentId: "main" },
    respond: vi.fn(),
  } as unknown as GatewayRequestHandlerOptions);
  await preview!({
    params: { agentId: "main" },
    respond: vi.fn(),
  } as unknown as GatewayRequestHandlerOptions);

  expect(backfillModule.loadCount).toBe(1);
  expect(backfillModule.executeSessionBackfillBatch).toHaveBeenCalledTimes(2);
});
