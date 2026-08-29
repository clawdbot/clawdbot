import { describe, expect, it, vi } from "vitest";
import type { GatewayAgentRow } from "../../api/types.ts";
import type { DraftCloudProfile } from "./discovery.ts";
import { contextWith } from "./model-control.test-support.ts";
import { NewSessionModelControl } from "./model-control.ts";

describe("new-session model runtime placement", () => {
  it.each([
    {
      name: "rejects a remote-exec runtime on a worker-turn profile",
      runtime: {
        id: "codex",
        cloudPlacementSupported: true,
        cloudPlacementExecutionMode: "remote-exec" as const,
        source: "model" as const,
      },
      executionModes: ["worker-turn"] as const,
      expected:
        "The codex runtime cannot use this cloud worker. Choose a compatible cloud worker or run locally.",
    },
    {
      name: "accepts a worker-turn runtime on a worker-turn profile",
      runtime: {
        id: "openclaw",
        cloudPlacementSupported: true,
        cloudPlacementExecutionMode: "worker-turn" as const,
        source: "model" as const,
      },
      executionModes: ["worker-turn"] as const,
      expected: undefined,
    },
    {
      name: "accepts a worker-turn runtime on a profile supporting both execution modes",
      runtime: {
        id: "openclaw",
        cloudPlacementSupported: true,
        cloudPlacementExecutionMode: "worker-turn" as const,
        source: "model" as const,
      },
      executionModes: ["worker-turn", "remote-exec"] as const,
      expected: undefined,
    },
    {
      name: "accepts a remote-exec runtime on the same dual-mode profile",
      runtime: {
        id: "codex",
        cloudPlacementSupported: true,
        cloudPlacementExecutionMode: "remote-exec" as const,
        source: "model" as const,
      },
      executionModes: ["worker-turn", "remote-exec"] as const,
      expected: undefined,
    },
    {
      name: "rejects a remote-exec runtime when the current profile supports only worker turns",
      runtime: {
        id: "codex",
        cloudPlacementSupported: true,
        cloudPlacementExecutionMode: "remote-exec" as const,
        source: "model" as const,
      },
      executionModes: ["worker-turn"] as const,
      expected:
        "The codex runtime cannot use this cloud worker. Choose a compatible cloud worker or run locally.",
    },
    {
      name: "rejects an empty placement mode set",
      runtime: {
        id: "codex",
        cloudPlacementSupported: true,
        cloudPlacementExecutionMode: "remote-exec" as const,
        source: "model" as const,
      },
      executionModes: [] as const,
      expected:
        "The codex runtime cannot use this cloud worker. Choose a compatible cloud worker or run locally.",
    },
    {
      name: "rejects a provider that advertises no placement execution mode",
      runtime: {
        id: "codex",
        cloudPlacementSupported: true,
        cloudPlacementExecutionMode: "remote-exec" as const,
        source: "model" as const,
      },
      expected:
        "The codex runtime cannot use this cloud worker. Choose a compatible cloud worker or run locally.",
    },
    {
      name: "retains the existing whole-runtime rejection",
      runtime: { id: "acpx", cloudPlacementSupported: false, source: "model" as const },
      expected: "The acpx runtime does not support cloud workers.",
    },
  ])("$name", ({ runtime, executionModes, expected }) => {
    const profile: DraftCloudProfile = {
      id: "aws",
      providerId: "crabbox",
      ...(executionModes === undefined ? {} : { executionModes }),
    };
    const control = new NewSessionModelControl(() => undefined);
    vi.spyOn(control, "resolveAgentRuntime").mockReturnValue(runtime);

    expect(control.cloudRuntimeUnsupportedReason(profile)).toBe(expected);
  });

  it.each([
    {
      name: "allows opted-in remote execution",
      runtimeId: "codex",
      devicePlacement: {
        requiredNodeCommands: ["codex.exec-server.stdio.v1"],
        consumesWorkerSlot: false,
      },
    },
    {
      name: "allows embedded execution",
      runtimeId: "openclaw",
      devicePlacement: { requiredNodeCommands: [], consumesWorkerSlot: true },
    },
    { name: "rejects a cloud-only runtime", runtimeId: "cloud-only" },
    {
      name: "rejects a stale support flag without an owner requirement",
      runtimeId: "stale",
      devicePlacementSupported: true,
    },
  ])("$name on paired devices", ({ runtimeId, devicePlacement, devicePlacementSupported }) => {
    const control = new NewSessionModelControl(() => undefined);
    vi.spyOn(control, "resolveAgentRuntime").mockReturnValue({
      id: runtimeId,
      cloudPlacementSupported: true,
      devicePlacementSupported: devicePlacementSupported ?? Boolean(devicePlacement),
      ...(devicePlacement ? { devicePlacement } : {}),
      source: "model",
    });

    expect(control.devicePlacementUnsupportedReason()).toBe(
      devicePlacement ? undefined : "This runtime does not support paired devices",
    );
  });

  it("uses model catalog runtime metadata for an explicit cloud target", async () => {
    const { context, request } = contextWith([
      {
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        provider: "openai",
        agentRuntime: { id: "codex", cloudPlacementSupported: true, source: "model" },
      },
    ]);
    const control = new NewSessionModelControl(() => undefined);
    control.load(context, "main", true);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    await vi.waitFor(() => {
      control.selected = "openai/gpt-5.6-luna";
      expect(control.resolveAgentRuntime({ context })).toEqual({
        id: "codex",
        cloudPlacementSupported: true,
        source: "model",
      });
    });
  });

  it("falls back to the selected agent runtime for its default model", () => {
    const { context } = contextWith([]);
    const agent = {
      id: "main",
      agentRuntime: { id: "claude-cli", cloudPlacementSupported: false, source: "agent" },
    } satisfies GatewayAgentRow & {
      agentRuntime: { id: string; cloudPlacementSupported: boolean; source: "agent" };
    };
    const control = new NewSessionModelControl(() => undefined);

    expect(control.resolveAgentRuntime({ agent, context })).toEqual({
      id: "claude-cli",
      cloudPlacementSupported: false,
      source: "agent",
    });
  });

  it("falls back to the session defaults runtime capability", () => {
    const { context } = contextWith([], "codex", [], true);
    const control = new NewSessionModelControl(() => undefined);

    expect(control.resolveAgentRuntime({ context })).toEqual({
      id: "codex",
      cloudPlacementSupported: true,
      source: "defaults",
    });
  });

  it.each(["auto", "default"])(
    "leaves the %s runtime selector unresolved for server-side policy",
    (runtime) => {
      const { context } = contextWith([], runtime);
      const control = new NewSessionModelControl(() => undefined);

      expect(control.resolveAgentRuntime({ context })).toBeUndefined();
    },
  );

  it("does not apply default runtime metadata to an explicit model", async () => {
    const { context } = contextWith(
      [{ id: "sonnet-4.6", name: "Sonnet 4.6", provider: "anthropic" }],
      "codex",
    );
    const control = new NewSessionModelControl(() => undefined);
    control.load(context, "main", true);
    control.selected = "anthropic/sonnet-4.6";

    await vi.waitFor(() => expect(control.resolveAgentRuntime({ context })).toBeUndefined());
  });
});
