// ACP stateful target driver tests cover ACP target state persistence and routing.
import { beforeEach, describe, expect, it, vi } from "vitest";

const resetMocks = vi.hoisted(() => ({
  performGatewaySessionReset: vi.fn(async () => ({
    ok: true as const,
    key: "agent:claude:acp:binding:discord:default:9373ab192b2317f4",
    entry: { sessionId: "next-session", updatedAt: 1 },
    agentId: "claude",
    storePath: "/tmp/claude-sessions.json",
  })),
}));
const sessionMetaMocks = vi.hoisted(() => ({
  readAcpSessionEntry: vi.fn(() => null),
}));
const resolveMocks = vi.hoisted(() => ({
  resolveConfiguredAcpBindingSpecBySessionKey: vi.fn(() => null),
}));

vi.mock("../../acp/persistent-bindings.lifecycle.js", () => ({
  ensureConfiguredAcpBindingReady: vi.fn(),
  ensureConfiguredAcpBindingSession: vi.fn(),
}));
vi.mock("./acp-stateful-target-reset.runtime.js", () => ({
  performGatewaySessionReset: resetMocks.performGatewaySessionReset,
}));
vi.mock("../../acp/runtime/session-meta.js", () => ({
  readAcpSessionEntry: sessionMetaMocks.readAcpSessionEntry,
}));
vi.mock("../../acp/persistent-bindings.resolve.js", () => ({
  resolveConfiguredAcpBindingSpecBySessionKey:
    resolveMocks.resolveConfiguredAcpBindingSpecBySessionKey,
}));

import { acpStatefulBindingTargetDriver } from "./acp-stateful-target-driver.js";

describe("acpStatefulBindingTargetDriver", () => {
  beforeEach(() => {
    resetMocks.performGatewaySessionReset.mockClear();
    sessionMetaMocks.readAcpSessionEntry.mockClear();
    resolveMocks.resolveConfiguredAcpBindingSpecBySessionKey.mockClear();
  });

  it("delegates bound resets to the gateway session reset authority", async () => {
    await expect(
      acpStatefulBindingTargetDriver.resetInPlace?.({
        cfg: {} as never,
        sessionKey: "agent:claude:acp:binding:discord:default:9373ab192b2317f4",
        reason: "new",
        commandSource: "discord:native",
        bindingTarget: {
          kind: "stateful",
          driverId: "acp",
          sessionKey: "agent:claude:acp:binding:discord:default:9373ab192b2317f4",
          agentId: "claude",
        },
      }),
    ).resolves.toEqual({
      ok: true,
      sessionKey: "agent:claude:acp:binding:discord:default:9373ab192b2317f4",
      sessionId: "next-session",
      storePath: "/tmp/claude-sessions.json",
    });

    expect(resetMocks.performGatewaySessionReset).toHaveBeenCalledWith({
      key: "agent:claude:acp:binding:discord:default:9373ab192b2317f4",
      reason: "new",
      commandSource: "discord:native",
    });
  });

  it("keeps ACP reset available when metadata has already been cleared", () => {
    expect(
      acpStatefulBindingTargetDriver.resolveTargetBySessionKey?.({
        cfg: {} as never,
        sessionKey: "agent:claude:acp:binding:discord:default:9373ab192b2317f4",
      }),
    ).toEqual({
      kind: "stateful",
      driverId: "acp",
      sessionKey: "agent:claude:acp:binding:discord:default:9373ab192b2317f4",
      agentId: "claude",
    });
  });
});
