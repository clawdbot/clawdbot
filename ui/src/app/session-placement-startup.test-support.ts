import { expect, vi } from "vitest";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import type { SessionCapability } from "../lib/sessions/index.ts";
import {
  type SessionPlacementRecovery,
  writeSessionPlacementRecovery,
} from "../lib/sessions/session-placement-recovery.ts";
import type { ApplicationGateway } from "./gateway.ts";
import { createInitialUserMessageHandoff } from "./initial-user-message-handoff.ts";
import createApplicationPlacementStartupRuntime from "./session-placement-startup.runtime.ts";
import { createApplicationPlacementStartup } from "./session-placement-startup.ts";

export function createStartupPlacement(
  state: string,
  generation: number,
  updatedAtMs = generation,
) {
  return {
    state,
    generation,
    createdAtMs: 1,
    updatedAtMs,
    stateChangedAtMs: updatedAtMs,
    ...(state === "active"
      ? {
          environmentId: "environment-1",
          activeOwnerEpoch: 1,
          workerBundleHash: "a".repeat(64),
          workspaceBaseManifestRef: "manifest",
          remoteWorkspaceDir: "/workspace",
        }
      : {}),
  };
}

export function createPlacementStartupHarness(
  request: ReturnType<typeof vi.fn>,
  options: {
    loadRuntime?: Parameters<typeof createApplicationPlacementStartup>[1];
    recoveryBeforeStartup?: boolean;
  } = {},
) {
  const sessionKey = "agent:cloud:startup";
  const client = {
    request,
    recoveryScope: "principal-a",
    recoveryScopeReady: true,
  };
  const gateway = {
    connection: { gatewayUrl: "ws://gateway.example" },
    snapshot: { phase: "connected", client, hello: {} },
    subscribe: vi.fn(() => () => undefined),
  } as unknown as ApplicationGateway;
  const row = {
    key: sessionKey,
    placement: createStartupPlacement("requested", 1),
  } as GatewaySessionRow;
  const state = { result: { sessions: [row] } as SessionsListResult };
  const sessions = {
    get state() {
      return state;
    },
    refresh: vi.fn(async () => undefined),
    subscribe: vi.fn(() => () => undefined),
  } as unknown as SessionCapability;
  const recovery: SessionPlacementRecovery = {
    sessionKey,
    messageId: "message-stable",
    message: "fix the cloud task",
    target: { kind: "profile", profileId: "aws" },
    agentId: "cloud",
    gatewayUrl: "ws://gateway.example",
    recoveryScope: "principal-a",
    phase: "dispatching",
  };
  if (options.recoveryBeforeStartup) {
    expect(writeSessionPlacementRecovery(recovery)).toBe(true);
  }
  const initialUserMessage = createInitialUserMessageHandoff();
  const dependencies = { gateway, sessions, initialUserMessage };
  const startup = createApplicationPlacementStartup(
    dependencies,
    options.loadRuntime ?? (async () => ({ default: createApplicationPlacementStartupRuntime })),
  );
  if (!options.recoveryBeforeStartup) {
    expect(writeSessionPlacementRecovery(recovery)).toBe(true);
  }
  return {
    startup,
    input: { recovery, persistRecovery: true, recovering: false, createdAt: 1_000 },
    client,
    gateway,
    sessions,
    state,
    initialUserMessage,
    dependencies,
  };
}

export async function flushStartupMicrotasks() {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}
