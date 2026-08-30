/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  GatewayBrowserClient,
  GatewayBrowserClientOptions,
  GatewayHelloOk,
} from "../api/gateway.ts";
import type { AgentsListResult } from "../api/types.ts";
import { createSessionCapability } from "../lib/sessions/index.ts";
import { sessionsResult } from "../lib/sessions/session-capability.test-support.ts";
import {
  createComposerProps,
  resetComposerFixture,
} from "../pages/chat/chat-composer.test-support.ts";
import { createTestChatPane } from "../pages/chat/chat-pane.test-support.ts";
import {
  admitQueuedMessageForSession,
  subscribeChatOutboxProjection,
} from "../pages/chat/chat-queue.ts";
import { handleSendChat } from "../pages/chat/chat-send-submit.ts";
import { renderChatComposer } from "../pages/chat/components/chat-composer.ts";
import { listStoredChatOutboxes } from "../pages/chat/composer-persistence.ts";
import {
  activeQueuedMessageEdit,
  beginQueuedMessageEdit,
  cancelQueuedMessageEdit,
  updateQueuedMessageEdit,
} from "../pages/chat/queued-message-edit.ts";
import {
  createGatewayRequestMock,
  type GatewayRequestMock,
} from "../test-helpers/gateway-client.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import "./app-host.ts";
import type { ApplicationRuntime } from "./bootstrap.ts";
import type { ApplicationContext, ApplicationGateway } from "./context.ts";
import { createApplicationGateway } from "./gateway-store.ts";
import { loadSettings } from "./settings.ts";

const HELLO: GatewayHelloOk = {
  type: "hello-ok",
  protocol: 1,
  auth: { role: "operator", scopes: [] },
};

function createGatewayHarness() {
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("sessionStorage", createStorageMock());
  const clients: Array<{
    opts: GatewayBrowserClientOptions;
    request: GatewayRequestMock;
    recoveryScope: string | undefined;
    recoveryScopeReady: boolean;
  }> = [];
  const gateway = createApplicationGateway(loadSettings(), "", "", (opts) => {
    const client = {
      opts,
      instanceId: opts.instanceId,
      gatewayUrl: opts.url,
      recoveryScope: undefined as string | undefined,
      recoveryScopeReady: false,
      addEventListener: () => () => {},
      start: vi.fn(),
      stop: vi.fn(() => {
        client.recoveryScopeReady = false;
      }),
      request: createGatewayRequestMock(async (method: string) => {
        if (method === "sessions.list") {
          return sessionsResult([], 1);
        }
        if (method === "chat.startup" || method === "chat.history") {
          return { messages: [] };
        }
        if (method === "chat.metadata") {
          return { models: [], commands: [] };
        }
        if (method === "sessions.branches.list") {
          return { branches: [] };
        }
        return {};
      }),
    };
    clients.push(client);
    return client as unknown as GatewayBrowserClient;
  });
  return { gateway, clients };
}

function renderGatewaySurface(
  gateway: ApplicationGateway,
  documentView?: "desktop" | "terminal",
): string {
  const originalUrl = `${location.pathname}${location.search}${location.hash}`;
  if (documentView) {
    history.replaceState({}, "", `?view=${documentView}`);
  }
  try {
    const app = document.createElement("openclaw-app") as unknown as {
      runtime: Pick<ApplicationRuntime, "context" | "documentMode">;
      render: () => { strings: readonly string[] };
      synchronizeGateway: (gateway: ApplicationGateway) => void;
    };
    app.runtime = {
      documentMode: null,
      context: {
        gateway,
        basePath: "",
        agentSelection: { state: { selectedId: null } },
        config: { current: { terminalEnabled: false } },
        theme: { resolvedMode: "dark" },
      } as unknown as ApplicationContext,
    };
    app.synchronizeGateway(gateway);
    const container = document.createElement("div");
    render(app.render(), container);
    return container.innerHTML;
  } finally {
    history.replaceState({}, "", originalUrl);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Control UI Gateway target lineage", () => {
  it.each(
    [false, true].flatMap((incognito) =>
      ["synthetic-recovery-a", "synthetic-recovery-b"].map((nextRecovery) => ({
        incognito,
        nextRecovery,
      })),
    ),
  )(
    "binds retained queue edits across recovery $nextRecovery (Incognito: $incognito)",
    async ({ incognito, nextRecovery }) => {
      vi.stubGlobal("requestIdleCallback", vi.fn());
      vi.stubGlobal("requestAnimationFrame", () => 1);
      vi.stubGlobal("cancelAnimationFrame", () => undefined);
      const { gateway, clients } = createGatewayHarness();
      const sessionKey = "agent:main:main";
      const agentsList = {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [{ id: "main" }],
      } satisfies AgentsListResult;
      const hello: GatewayHelloOk = {
        ...HELLO,
        auth: { role: "operator", scopes: ["operator.read", "operator.write"] },
        snapshot: {
          sessionDefaults: { defaultAgentId: "main", mainKey: "main", mainSessionKey: sessionKey },
        },
      };
      gateway.connect({ gatewayUrl: "wss://synthetic-owner.example.test" });
      clients[0]!.opts.onHello?.(hello);
      clients[0]!.recoveryScope = "synthetic-recovery-a";
      clients[0]!.recoveryScopeReady = true;
      clients[0]!.opts.onRecoveryScopeChange?.();
      const sessions = createSessionCapability(gateway);
      const { pane, state } = createTestChatPane({ client: gateway.snapshot.client!, sessions });
      state.sessionKey = sessionKey;
      state.agentsList = agentsList;
      state.settings = { ...loadSettings(), gatewayUrl: gateway.connection.gatewayUrl, sessionKey };
      state.selectedChatSessionIncognito = incognito;
      state.loadAssistantIdentity = vi.fn(async () => undefined);
      pane.presented = false;
      pane.context = {
        ...pane.context,
        gateway,
        agents: { state: { agentsList }, ensureList: async () => agentsList },
      } as unknown as ApplicationContext;
      pane.applyGatewaySnapshot(gateway.snapshot);
      const releasePane = gateway.subscribe(pane.applyGatewaySnapshot.bind(pane));
      const releaseOutbox = subscribeChatOutboxProjection(state);
      const app = document.createElement("openclaw-app") as unknown as {
        runtime: Pick<ApplicationRuntime, "context" | "documentMode">;
        synchronizeGateway: (gateway: ApplicationGateway) => void;
        render: () => unknown;
      };
      app.runtime = { context: pane.context, documentMode: null };
      const shellContainer = document.createElement("div");
      const drawShell = () => {
        app.synchronizeGateway(gateway);
        render(app.render(), shellContainer);
      };
      drawShell();
      const originalShell = shellContainer.querySelector("openclaw-app-shell");
      expect(originalShell).not.toBeNull();
      const releaseShell = gateway.subscribe(drawShell);
      const composer = document.createElement("div");
      try {
        expect(
          admitQueuedMessageForSession(state, sessionKey, {
            id: "owner-row",
            text: "Original queued message",
            createdAt: 1000,
            sessionKey,
            sendState: "waiting-reconnect",
          }),
        ).toBe(true);
        expect(beginQueuedMessageEdit(state, "owner-row")).toBe("started");
        const captured = state.chatQueuedEdit!;
        const initialClient = state.client;
        const outboxes = listStoredChatOutboxes(state);
        // Socket loss invalidates readiness but retains this client's authenticated owner.
        clients[0]!.recoveryScopeReady = false;
        clients[0]!.opts.onClose?.({ code: 1006, reason: "offline", willRetry: true });
        expect(state.connected).toBe(false);
        expect(updateQueuedMessageEdit(state, "Unsaved offline correction")).toBe(true);
        expect(activeQueuedMessageEdit(state)).toBe(captured);
        gateway.connect();
        expect(gateway.snapshot.phase).toBe("reconnecting");
        expect(shellContainer.querySelector("openclaw-app-shell")).toBe(originalShell);
        // Hello precedes recovery resolution. Neither a replacement transport nor
        // pending authentication can act on the old owner's retained correction.
        clients[1]!.opts.onHello?.(hello);
        expect.soft(activeQueuedMessageEdit(state)).toBeNull();
        expect.soft(cancelQueuedMessageEdit(state)).toBe(false);
        expect(beginQueuedMessageEdit(state, captured.id)).toBe("unavailable");
        clients[1]!.recoveryScope = nextRecovery;
        clients[1]!.recoveryScopeReady = true;
        clients[1]!.opts.onRecoveryScopeChange?.();
        await vi.waitFor(() => expect(state.chatLoading).toBe(false));
        const sameOwner = nextRecovery === "synthetic-recovery-a";
        const active = activeQueuedMessageEdit(state);
        render(
          renderChatComposer(
            createComposerProps({
              queue: state.chatQueue,
              sessionKey,
              queuedEdit: {
                editingId: active?.id ?? null,
                editingText: active?.draftText,
                source: active?.source,
                onCancel: () => cancelQueuedMessageEdit(state),
              },
            }),
          ),
          composer,
        );
        if (!sameOwner) {
          await handleSendChat(state, captured.draftText, {
            resumeQueuedMessageEditId: captured.id,
            attachmentsOverride: captured.attachments,
          });
          expect(clients[1]!.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
        }
        expect(listStoredChatOutboxes(state)).toEqual(outboxes);
        expect(shellContainer.querySelector("openclaw-app-shell")).toBe(originalShell);
        expect(pane.state).toBe(state);
        expect(state.client).not.toBe(initialClient);
        expect.soft(Boolean(active)).toBe(sameOwner);
        expect
          .soft(
            composer.querySelector<HTMLTextAreaElement>(".chat-queue__edit-input")?.value ?? null,
          )
          .toBe(sameOwner ? captured.draftText : null);
        if (sameOwner) {
          const settings = state.settings;
          state.settings = { ...settings, gatewayUrl: "wss://different-owner.example.test" };
          expect(activeQueuedMessageEdit(state)).toBeNull();
          expect(cancelQueuedMessageEdit(state)).toBe(false);
          expect(state.chatQueuedEdit).toBe(captured);
          state.settings = settings;
        }
        expect.soft(cancelQueuedMessageEdit(state)).toBe(sameOwner);
        if (!sameOwner) {
          expect.soft(state.chatQueuedEdit).toBe(captured);
        }
      } finally {
        releaseShell();
        releasePane();
        releaseOutbox();
        render(null, composer);
        render(null, shellContainer);
        pane.disconnectedCallback();
        sessions.dispose();
        gateway.stop();
        await resetComposerFixture();
      }
    },
  );

  it("returns to the login gate when a newly selected Gateway's first attempt fails", () => {
    const { gateway, clients } = createGatewayHarness();
    gateway.start();
    clients[0]?.opts.onHello?.(HELLO);
    gateway.connect({ gatewayUrl: "wss://other-gateway.example.test" });
    clients[1]?.opts.onClose?.({ code: 1006, reason: "remote refused", willRetry: true });

    const surface = renderGatewaySurface(gateway);

    expect(surface).toContain("<openclaw-login-gate");
    expect(surface).not.toContain("<openclaw-app-shell");
  });

  it("re-scopes credentials when the login draft changes Gateway", () => {
    const { gateway, clients } = createGatewayHarness();
    gateway.connect({ token: "old-token", password: "old-password" });
    clients[0]?.opts.onClose?.({ code: 1006, reason: "login required", willRetry: true });
    const app = document.createElement("openclaw-app") as unknown as {
      runtime: Pick<ApplicationRuntime, "context" | "documentMode">;
      render: () => { strings: readonly string[] };
      synchronizeGateway: (gateway: ApplicationGateway) => void;
    };
    app.runtime = {
      documentMode: null,
      context: {
        gateway,
        basePath: "",
        agentSelection: { state: { selectedId: null } },
        config: { current: { terminalEnabled: false } },
        theme: { resolvedMode: "dark" },
      } as unknown as ApplicationContext,
    };
    app.synchronizeGateway(gateway);
    const container = document.createElement("div");
    render(app.render(), container);
    const loginGate = container.querySelector("openclaw-login-gate") as unknown as {
      props: {
        onGatewayUrlChange: (value: string) => void;
        onConnect: () => void;
      };
    };

    loginGate.props.onGatewayUrlChange("wss://other-gateway.example.test");
    loginGate.props.onConnect();

    expect(clients[1]?.opts.token).toBeUndefined();
    expect(clients[1]?.opts.password).toBeUndefined();
  });

  it("keeps retryable Gateway startup on the initial progress surface", () => {
    const { gateway, clients } = createGatewayHarness();
    gateway.start();
    clients[0]?.opts.onClose?.({
      code: 4013,
      reason: "gateway starting",
      willRetry: true,
      error: {
        code: "UNAVAILABLE",
        message: "gateway starting; retry shortly",
        details: { reason: "startup-sidecars" },
        retryable: true,
        retryAfterMs: 250,
      },
    });

    const surface = renderGatewaySurface(gateway);

    expect(gateway.snapshot.phase).toBe("starting");
    expect(surface).toContain('class="connect-splash"');
    expect(surface).toContain("Gateway starting…");
    expect(surface).not.toContain("<openclaw-login-gate");
  });

  it("shows startup progress after a manual connection attempt", () => {
    const { gateway, clients } = createGatewayHarness();
    gateway.start();
    clients[0]?.opts.onClose?.({
      code: 1006,
      reason: "manual connection required",
      willRetry: true,
    });
    const app = document.createElement("openclaw-app") as unknown as {
      runtime: Pick<ApplicationRuntime, "context" | "documentMode">;
      render: () => { strings: readonly string[] };
      synchronizeGateway: (gateway: ApplicationGateway) => void;
    };
    app.runtime = {
      documentMode: null,
      context: {
        gateway,
        basePath: "",
        agentSelection: { state: { selectedId: null } },
        config: { current: { terminalEnabled: false } },
        theme: { resolvedMode: "dark" },
      } as unknown as ApplicationContext,
    };
    app.synchronizeGateway(gateway);
    const container = document.createElement("div");
    render(app.render(), container);
    const loginGate = container.querySelector("openclaw-login-gate") as unknown as {
      props: { onConnect: () => void };
    };

    loginGate.props.onConnect();
    clients[1]?.opts.onClose?.({
      code: 4013,
      reason: "gateway starting",
      willRetry: true,
      error: {
        code: "UNAVAILABLE",
        message: "gateway starting; retry shortly",
        details: { reason: "startup-sidecars" },
        retryable: true,
        retryAfterMs: 250,
      },
    });
    render(app.render(), container);

    expect(container.innerHTML).toContain("Gateway starting…");
    expect(container.innerHTML).not.toContain("<openclaw-login-gate");

    clients[1]?.opts.onHello?.(HELLO);
    render(app.render(), container);
    expect(container.innerHTML).toContain("<openclaw-app-shell");
  });

  it.each(["desktop", "terminal"] as const)(
    "shows retryable Gateway startup in the standalone %s document",
    (documentView) => {
      const { gateway, clients } = createGatewayHarness();
      gateway.start();
      clients[0]?.opts.onClose?.({
        code: 4013,
        reason: "gateway starting",
        willRetry: true,
        error: {
          code: "UNAVAILABLE",
          message: "gateway starting; retry shortly",
          details: { reason: "startup-sidecars" },
          retryable: true,
          retryAfterMs: 250,
        },
      });

      const surface = renderGatewaySurface(gateway, documentView);

      expect(surface).toContain('class="connect-splash"');
      expect(surface).toContain("Gateway starting…");
    },
  );

  it("keeps an established Gateway's dashboard mounted during its own retry", () => {
    const { gateway, clients } = createGatewayHarness();
    gateway.start();
    clients[0]?.opts.onHello?.(HELLO);
    clients[0]?.opts.onClose?.({ code: 1006, reason: "same gateway blip", willRetry: true });

    const surface = renderGatewaySurface(gateway);

    expect(surface).toContain("<openclaw-app-shell");
    expect(surface).not.toContain("<openclaw-login-gate");
  });

  it("retains a replacement Gateway's dashboard after its own successful hello", () => {
    const { gateway, clients } = createGatewayHarness();
    gateway.start();
    clients[0]?.opts.onHello?.(HELLO);
    gateway.connect({ gatewayUrl: "wss://other-gateway.example.test" });
    clients[1]?.opts.onHello?.(HELLO);
    clients[1]?.opts.onClose?.({ code: 1006, reason: "replacement blip", willRetry: true });

    const surface = renderGatewaySurface(gateway);

    expect(surface).toContain("<openclaw-app-shell");
    expect(surface).not.toContain("<openclaw-login-gate");
  });
});
