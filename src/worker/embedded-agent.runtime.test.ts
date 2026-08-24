// Covers the worker session loop-guard resolution in the three operator
// states: no serialized state (guards off), an opt-out (enabled: false
// resolves to all-undefined), and per-agent limits resolved by the gateway
// and carried across the process boundary in the launch descriptor.
//
// The resolver is module-internal (only the turn harness consumes it, so an
// export would trip the production Knip scan), so these tests exercise it
// through the public runWorkerEmbeddedTurn harness and assert the guard
// config the runtime hands to createAgentSession.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { LoopGuardRuntimeConfig } from "../agents/tool-loop-detection-config.js";
import { runWorkerEmbeddedTurn } from "./embedded-agent.runtime.js";

const { createAgentSessionMock } = vi.hoisted(() => ({ createAgentSessionMock: vi.fn() }));

vi.mock("../agents/sessions/sdk.js", () => ({
  createAgentSession: createAgentSessionMock,
}));

const MODEL_REF = { provider: "openai", model: "gpt-5.6-luna" } as const;

function stubSession() {
  return {
    agent: {
      sessionId: "",
      streamFn: undefined,
      abort: vi.fn(),
      prompt: vi.fn(async () => {}),
      waitForIdle: vi.fn(async () => {}),
      state: { messages: [] as unknown[] },
    },
    setActiveToolsByName: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    dispose: vi.fn(),
  };
}

async function runTurnWithGuardState(
  serialized: LoopGuardRuntimeConfig | undefined,
): Promise<LoopGuardRuntimeConfig | undefined> {
  const cwd = await mkdtemp(path.join(tmpdir(), "embedded-agent-runtime-"));
  createAgentSessionMock.mockReset().mockResolvedValue({ session: stubSession() });
  try {
    await runWorkerEmbeddedTurn({
      agentId: "test-agent",
      operationalRunInstance: { instanceId: "worker-instance", runId: "worker-run" },
      agentRuntimeIdentityToken: "test-identity-token",
      cwd,
      workerContainmentRoot: cwd,
      stateDir: cwd,
      sessionId: "worker-session",
      sessionKey: "worker-session-key",
      runId: "worker-run",
      prompt: "ping",
      modelRef: MODEL_REF,
      inference: {
        stream: async () => {
          throw new Error("inference stream unused");
        },
      },
      transcript: { commit: vi.fn(async () => {}) },
      live: { enqueuePreview: vi.fn(() => true), emitTerminal: vi.fn(async () => {}) },
      allowedToolNames: [],
      ...(serialized === undefined ? {} : { loopGuardConfig: serialized }),
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
  expect(createAgentSessionMock).toHaveBeenCalledTimes(1);
  return createAgentSessionMock.mock.calls[0]?.[0]?.loopGuardConfig;
}

describe("worker session loop-guard resolution", () => {
  it("keeps guards off when no state is serialized (opt-in fallback)", async () => {
    await expect(runTurnWithGuardState(undefined)).resolves.toEqual({
      maxTurns: undefined,
      maxConsecutiveErrorBatches: undefined,
      maxIdleRepeatCalls: undefined,
    });
  });

  it("honors a gateway-serialized opt-out (enabled: false) as all-undefined", async () => {
    await expect(
      runTurnWithGuardState({
        maxTurns: undefined,
        maxConsecutiveErrorBatches: undefined,
        maxIdleRepeatCalls: undefined,
      }),
    ).resolves.toEqual({
      maxTurns: undefined,
      maxConsecutiveErrorBatches: undefined,
      maxIdleRepeatCalls: undefined,
    });
  });

  it("honors gateway-serialized per-agent limits", async () => {
    await expect(
      runTurnWithGuardState({
        maxTurns: 50,
        maxConsecutiveErrorBatches: 3,
        maxIdleRepeatCalls: 5,
      }),
    ).resolves.toEqual({
      maxTurns: 50,
      maxConsecutiveErrorBatches: 3,
      maxIdleRepeatCalls: 5,
    });
  });
});
