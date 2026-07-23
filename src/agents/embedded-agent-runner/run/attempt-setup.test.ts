import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderRuntimePluginHandle } from "../../../plugins/provider-hook-runtime.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

const resolveProviderRuntimePluginHandle = vi.hoisted(() => vi.fn());

vi.mock("../../../plugins/provider-hook-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/provider-hook-runtime.js")>()),
  resolveProviderRuntimePluginHandle,
}));

import { prepareEmbeddedAttemptSetup } from "./attempt-setup.js";

describe("prepareEmbeddedAttemptSetup", () => {
  beforeEach(() => {
    resolveProviderRuntimePluginHandle.mockReset();
  });

  it("reuses lifecycle metadata and the provider handle from the runtime plan", async () => {
    const metadataSnapshot = { plugins: [] } as never;
    const workspaceDir = path.join(os.tmpdir(), "openclaw-attempt-setup-prepared");
    const providerRuntimeHandle: ProviderRuntimePluginHandle & { prepared: true } = {
      provider: "openai",
      modelId: "gpt-5.4",
      prepared: true,
      workspaceDir,
      plugin: {} as never,
    };
    const setup = await prepareEmbeddedAttemptSetup({
      config: {},
      modelId: "gpt-5.4",
      provider: "openai",
      runId: "run-prepared",
      sessionId: "session-prepared",
      thinkLevel: "high",
      timeoutMs: 30_000,
      workspaceDir,
      preparedModelRuntime: { metadataSnapshot } as never,
      runtimePlan: { providerRuntimeHandle } as never,
    } as unknown as EmbeddedRunAttemptParams);

    expect(setup.getCurrentAttemptPluginMetadataSnapshot()).toBe(metadataSnapshot);
    expect(setup.getProviderRuntimeHandle()).toBe(providerRuntimeHandle);
    expect(resolveProviderRuntimePluginHandle).not.toHaveBeenCalled();
  });

  it("resolves partial handles without trusting scoped metadata", async () => {
    const resolvedHandle: ProviderRuntimePluginHandle = {
      provider: "openai",
      modelId: "gpt-5.4",
    };
    resolveProviderRuntimePluginHandle.mockReturnValue(resolvedHandle);
    const setup = await prepareEmbeddedAttemptSetup({
      config: {},
      modelId: "gpt-5.4",
      provider: "openai",
      runId: "run-partial",
      sessionId: "session-partial",
      thinkLevel: "high",
      timeoutMs: 30_000,
      workspaceDir: path.join(os.tmpdir(), "openclaw-attempt-setup-partial"),
      preparedModelRuntime: {
        metadataSnapshot: { pluginIds: ["other"] },
      } as never,
      runtimePlan: { providerRuntimeHandle: { provider: "openai" } } as never,
    } as unknown as EmbeddedRunAttemptParams);

    const preparedHandle = setup.getProviderRuntimeHandle();
    expect(preparedHandle).toMatchObject(resolvedHandle);
    expect(preparedHandle.modelId).toBe("gpt-5.4");
    expect(setup.getProviderRuntimeHandle()).toBe(preparedHandle);
    expect(resolveProviderRuntimePluginHandle).toHaveBeenCalledOnce();
    const call = resolveProviderRuntimePluginHandle.mock.calls[0]?.[0];
    expect(call).toMatchObject({ provider: "openai", modelId: "gpt-5.4" });
    expect(call).not.toHaveProperty("pluginMetadataSnapshot");
  });
});
