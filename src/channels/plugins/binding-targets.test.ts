// Binding target tests cover channel binding target extraction and validation.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureConfiguredBindingTargetReady,
  resetConfiguredBindingTargetInPlace,
} from "./binding-targets.js";
import type { ConfiguredBindingResolution } from "./binding-types.js";
import {
  registerStatefulBindingTargetDriver,
  type StatefulBindingTargetDriver,
} from "./stateful-target-drivers.js";

function createBindingResolution(driverId: string): ConfiguredBindingResolution {
  return {
    conversation: {
      channel: "demo-binding",
      accountId: "default",
      conversationId: "123",
    },
    compiledBinding: {
      channel: "demo-binding",
      binding: {
        type: "acp" as const,
        agentId: "codex",
        match: {
          channel: "demo-binding",
          peer: {
            kind: "channel" as const,
            id: "123",
          },
        },
        acp: {
          mode: "persistent",
        },
      },
      bindingConversationId: "123",
      target: {
        conversationId: "123",
      },
      agentId: "codex",
      provider: {
        compileConfiguredBinding: () => ({
          conversationId: "123",
        }),
        matchInboundConversation: () => ({
          conversationId: "123",
        }),
      },
      targetFactory: {
        driverId,
        materialize: () => ({
          record: {
            bindingId: "binding:123",
            targetSessionKey: `agent:codex:${driverId}`,
            targetKind: "session",
            conversation: {
              channel: "demo-binding",
              accountId: "default",
              conversationId: "123",
            },
            status: "active",
            boundAt: 0,
          },
          statefulTarget: {
            kind: "stateful",
            driverId,
            sessionKey: `agent:codex:${driverId}`,
            agentId: "codex",
          },
        }),
      },
    },
    match: {
      conversationId: "123",
    },
    record: {
      bindingId: "binding:123",
      targetSessionKey: `agent:codex:${driverId}`,
      targetKind: "session",
      conversation: {
        channel: "demo-binding",
        accountId: "default",
        conversationId: "123",
      },
      status: "active",
      boundAt: 0,
    },
    statefulTarget: {
      kind: "stateful",
      driverId,
      sessionKey: `agent:codex:${driverId}`,
      agentId: "codex",
    },
  };
}

let unregisterDriver: (() => void) | undefined;

afterEach(() => {
  unregisterDriver?.();
  unregisterDriver = undefined;
});

describe("binding target drivers", () => {
  it("delegates ensureReady to the resolved driver", async () => {
    const ensureReady = vi.fn(async () => ({ ok: true as const }));
    const ensureSession = vi.fn(async () => ({
      ok: true as const,
      sessionKey: "agent:codex:test-driver",
    }));
    const driver: StatefulBindingTargetDriver = {
      id: "test-driver",
      ensureReady,
      ensureSession,
    };
    unregisterDriver = registerStatefulBindingTargetDriver(driver);

    const bindingResolution = createBindingResolution("test-driver");
    await expect(
      ensureConfiguredBindingTargetReady({
        cfg: {} as never,
        bindingResolution,
      }),
    ).resolves.toEqual({ ok: true });
    expect(ensureReady).toHaveBeenCalledTimes(1);
    expect(ensureReady).toHaveBeenCalledWith({
      cfg: {} as never,
      bindingResolution,
    });
  });

  it("resolves resetInPlace through the driver session-key lookup", async () => {
    const resetInPlace = vi.fn(async () => ({ ok: true as const }));
    const driver: StatefulBindingTargetDriver = {
      id: "test-driver",
      ensureReady: async () => ({ ok: true }),
      ensureSession: async () => ({
        ok: true,
        sessionKey: "agent:codex:test-driver",
      }),
      resolveTargetBySessionKey: ({ sessionKey }) => ({
        kind: "stateful",
        driverId: "test-driver",
        sessionKey,
        agentId: "codex",
      }),
      resetInPlace,
    };
    unregisterDriver = registerStatefulBindingTargetDriver(driver);

    await expect(
      resetConfiguredBindingTargetInPlace({
        cfg: {} as never,
        sessionKey: "agent:codex:test-driver",
        reason: "reset",
        commandSource: "discord:native",
      }),
    ).resolves.toEqual({ ok: true });

    expect(resetInPlace).toHaveBeenCalledTimes(1);
    expect(resetInPlace).toHaveBeenCalledWith({
      cfg: {} as never,
      sessionKey: "agent:codex:test-driver",
      reason: "reset",
      commandSource: "discord:native",
      bindingTarget: {
        kind: "stateful",
        driverId: "test-driver",
        sessionKey: "agent:codex:test-driver",
        agentId: "codex",
      },
    });
  });

  it("returns a typed error when no driver is registered", async () => {
    const bindingResolution = createBindingResolution("missing-driver");

    await expect(
      ensureConfiguredBindingTargetReady({
        cfg: {} as never,
        bindingResolution,
      }),
    ).resolves.toEqual({
      ok: false,
      error: "Configured binding target driver unavailable: missing-driver",
    });
  });
});
