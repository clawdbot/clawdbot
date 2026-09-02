/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import {
  createSessionCapabilityFixture,
  createTestChatPane,
  type TestChatPane,
} from "./chat-pane.test-support.ts";

function advertiseSessionRecovery(pane: TestChatPane) {
  pane.context.gateway.snapshot.hello = {
    auth: { role: "operator", scopes: ["operator.write"] },
    features: { methods: ["sessions.recover"] },
  } as typeof pane.context.gateway.snapshot.hello;
}

describe("chat pane session recovery", () => {
  it("unlocks the composer when shared session state settles the exact local run", () => {
    const { pane, state } = createTestChatPane({
      client: {} as GatewayBrowserClient,
      sessions: createSessionCapabilityFixture(),
    });
    state.chatRunId = "run-missed-terminal";
    state.chatStream = "answer already rendered";

    pane.applySessionsState({
      result: {
        sessions: [
          {
            key: state.sessionKey,
            kind: "direct",
            updatedAt: 20,
            status: "done",
            hasActiveRun: false,
            lastRunId: "run-missed-terminal",
          },
        ],
      },
      agentId: "main",
      loading: false,
      error: null,
      deletedSessions: [],
    } as unknown as Parameters<typeof pane.applySessionsState>[0]);

    expect(state.chatRunId).toBeNull();
    expect(state.chatStream).toBeNull();
  });

  it("recovers a tombstoned session into a fresh continuing session", async () => {
    const created = createDeferred<Awaited<ReturnType<SessionCapability["recover"]>>>();
    const sessions = {
      recover: vi.fn(() => created.promise),
    } as unknown as SessionCapability;
    const client = {} as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions });
    const navigate = vi.fn();
    pane.onPaneSessionChange = navigate;
    advertiseSessionRecovery(pane);

    expect(pane.restartRecoveryComposerBanner()).toMatchObject({
      title: "This session ended during a restart.",
      text: "Its transcript is safe.",
      tone: "neutral",
      icon: "warning",
      actionLabel: "Resume in new session",
      actionStyle: "primary",
      busy: false,
    });

    const pending = pane.recoverSession();
    await vi.waitFor(() => expect(sessions.recover).toHaveBeenCalledOnce());
    expect(pane.restartRecoveryComposerBanner()).toMatchObject({
      actionLabel: "Resume in new session",
      actionStyle: "primary",
      busy: true,
      busyLabel: "Resuming…",
    });
    created.resolve({
      ok: true,
      key: "agent:main:dashboard:recovered",
      sessionId: "recovered-session",
      continuation: { status: "started", runId: "recovery-run" },
    });

    await expect(pending).resolves.toBe(true);

    expect(sessions.recover).toHaveBeenCalledWith({
      agentId: "main",
      key: "agent:main:current",
    });
    expect(navigate).toHaveBeenCalledWith(pane.paneId, "agent:main:dashboard:recovered");
    expect(state.sessionKey).toBe("agent:main:current");
  });

  it("reuses the recovered session after a same-client reconnect", async () => {
    const created = createDeferred<Awaited<ReturnType<SessionCapability["recover"]>>>();
    const recovered = {
      ok: true as const,
      key: "agent:main:dashboard:recovered",
      sessionId: "recovered-session",
      continuation: { status: "started" as const, runId: "recovery-run" },
    };
    const sessions = {
      recover: vi
        .fn<SessionCapability["recover"]>()
        .mockImplementationOnce(() => created.promise)
        .mockResolvedValueOnce(recovered),
    } as unknown as SessionCapability;
    const client = {} as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions });
    const navigate = vi.fn();
    pane.onPaneSessionChange = navigate;
    advertiseSessionRecovery(pane);

    const pending = pane.recoverSession();
    await vi.waitFor(() => expect(sessions.recover).toHaveBeenCalledOnce());
    state.connected = false;
    pane.connectionGeneration += 1;
    state.connectionEpoch = pane.connectionGeneration;
    state.connected = true;
    pane.connectionGeneration += 1;
    state.connectionEpoch = pane.connectionGeneration;
    created.resolve(recovered);

    await expect(pending).resolves.toBe(false);
    expect(navigate).not.toHaveBeenCalled();

    await expect(pane.recoverSession()).resolves.toBe(true);
    expect(sessions.recover).toHaveBeenCalledTimes(2);
    expect(navigate).toHaveBeenCalledWith(pane.paneId, "agent:main:dashboard:recovered");
  });

  it("keeps the recovery action available when continuation launch is rejected", async () => {
    const successor = {
      ok: true as const,
      key: "agent:main:dashboard:recovered",
      sessionId: "recovered-session",
    };
    const sessions = {
      recover: vi
        .fn<SessionCapability["recover"]>()
        .mockResolvedValueOnce({
          ...successor,
          continuation: {
            status: "rejected",
            error: { code: "UNAVAILABLE", message: "Continuation was not started." },
          },
        })
        .mockResolvedValueOnce({
          ...successor,
          continuation: { status: "started", runId: "recovery-run" },
        }),
    } as unknown as SessionCapability;
    const { pane, state } = createTestChatPane({
      client: {} as GatewayBrowserClient,
      sessions,
    });
    const navigate = vi.fn();
    pane.onPaneSessionChange = navigate;
    advertiseSessionRecovery(pane);

    await expect(pane.recoverSession()).resolves.toBe(false);
    expect(state.chatError).toBe("Continuation was not started.");
    expect(navigate).not.toHaveBeenCalled();

    await expect(pane.recoverSession()).resolves.toBe(true);
    expect(sessions.recover).toHaveBeenCalledTimes(2);
    expect(navigate).toHaveBeenCalledWith(pane.paneId, successor.key);
  });
});
