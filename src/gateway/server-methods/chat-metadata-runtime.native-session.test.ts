import { describe, expect, onTestFinished, test } from "vitest";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createChatMetadataHarness } from "./chat-metadata-runtime.test-support.js";

describe("gateway chat metadata native session ownership", () => {
  test("keeps native-owned model auth scoped across pending and materialized chat metadata", async () => {
    const config = {
      agents: {
        defaults: { model: { primary: "openai/gpt-5.6-sol" } },
        entries: { main: {} },
      },
    } satisfies OpenClawConfig;
    const harness = createChatMetadataHarness(config);
    const hostModels = [
      {
        id: "gpt-5.6-sol",
        name: "Sol",
        provider: "openai",
        available: false,
        unavailableReason: "missing-auth",
      },
      {
        id: "gpt-5.6-luna",
        name: "Luna",
        provider: "openai",
        available: false,
        unavailableReason: "cooldown",
        unavailableUntil: 123_456,
      },
    ];
    harness.buildProjection.mockResolvedValue({ modelCatalog: hostModels, models: hostModels });
    const sessionEntry: InternalSessionEntry = {
      sessionId: "native-metadata-session",
      updatedAt: 1,
      agentHarnessId: "test-native",
      modelSelectionLocked: true,
    };
    const request = {
      agentId: "main",
      sessionKey: "agent:main:harness:test-native:metadata",
      sessionEntry,
    };
    let boundSessionId = sessionEntry.sessionId;
    let ownership:
      | { model: "native"; auth: "native" | "host"; modelRef?: { provider: string; model: string } }
      | undefined = {
      model: "native",
      auth: "native",
    };
    const registry = createEmptyPluginRegistry();
    registry.agentHarnesses.push({
      pluginId: "test-native",
      source: "test",
      harness: {
        id: "test-native",
        label: "Native metadata owner",
        supports: () => ({ supported: true }),
        runAttempt: async () => {
          throw new Error("metadata must not start a model turn");
        },
        resolveSessionRuntimeOwnership: (params) => {
          params.assertCurrent();
          return params.sessionKey === request.sessionKey && params.sessionId === boundSessionId
            ? ownership
            : undefined;
        },
      },
    });
    setActivePluginRegistry(registry);
    onTestFinished(resetPluginRuntimeStateForTest);
    await harness.runtime.refresh();
    const neutral = await harness.runtime.read({ agentId: "main" });
    expect(neutral.models).toEqual(hostModels);

    const pending = await harness.runtime.read(request);
    expect(pending.models).toEqual([
      { id: "gpt-5.6-sol", name: "Sol", provider: "openai" },
      hostModels[1],
    ]);
    expect((await harness.runtime.readStartup(request))?.metadata).toEqual(pending);
    const history = await harness.runtime.readStartup({ ...request, readPolicy: "ready" });
    expect(history).not.toHaveProperty("metadata");
    expect(history?.sessionModelCatalog).toBe(hostModels);

    ownership = {
      model: "native",
      auth: "native",
      modelRef: { provider: "openai", model: "gpt-5.6-luna" },
    };
    sessionEntry.model = "gpt-5.6-luna";
    sessionEntry.modelProvider = "openai";
    const materialized = await harness.runtime.read(request);
    expect(materialized.models).toEqual([
      hostModels[0],
      { id: "gpt-5.6-luna", name: "Luna", provider: "openai" },
    ]);
    expect((await harness.runtime.readStartup(request))?.metadata).toEqual(materialized);
    expect(await harness.runtime.read({ agentId: "main" })).toEqual(neutral);
    expect(hostModels[0]).toHaveProperty("available", false);
    expect(hostModels[1]).toHaveProperty("unavailableUntil", 123_456);

    // The same pin can retain native model ownership while requiring host auth.
    ownership = { ...ownership, auth: "host" };
    expect((await harness.runtime.read(request)).models).toEqual(hostModels);
    ownership = { ...ownership, auth: "native" };
    sessionEntry.pluginOwnerId = "test-native";
    expect((await harness.runtime.read(request)).models).toEqual(hostModels);
    delete sessionEntry.pluginOwnerId;
    boundSessionId = "replacement-session";
    expect((await harness.runtime.read(request)).models).toEqual(hostModels);
    boundSessionId = sessionEntry.sessionId;
    ownership = undefined;
    expect((await harness.runtime.read(request)).models).toEqual(hostModels);
    setActivePluginRegistry(createEmptyPluginRegistry());
    expect((await harness.runtime.read(request)).models).toEqual(hostModels);
  });
});
