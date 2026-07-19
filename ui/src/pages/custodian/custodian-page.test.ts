/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GatewayBrowserClient,
  GatewayEventFrame,
  GatewayEventListener,
} from "../../api/gateway.ts";
import type {
  ApplicationContext,
  ApplicationGateway,
  ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import {
  createApplicationContextProvider,
  type ApplicationContextProvider,
} from "../../test-helpers/application-context.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import "./custodian-page.ts";

type TestCustodianPage = HTMLElement & {
  onboarding: boolean;
  updateComplete: Promise<boolean>;
};

type ContextHarness = {
  context: ApplicationContext;
  setGatewaySnapshot: (patch: Partial<ApplicationGatewaySnapshot>) => void;
  setGatewayUrl: (gatewayUrl: string) => void;
  setGatewayToken: (token: string) => void;
  setGatewayBootstrapToken: (bootstrapToken: string) => void;
  setGatewayDeviceToken: (deviceToken: string) => void;
  emitGatewayEvent: (event: Pick<GatewayEventFrame, "event" | "payload">) => void;
};

function createContext(request: ReturnType<typeof vi.fn>): ContextHarness {
  const client = { request } as unknown as GatewayBrowserClient;
  let snapshot: ApplicationGatewaySnapshot = {
    client,
    connected: true,
    reconnecting: false,
    hello: {
      type: "hello-ok" as const,
      protocol: 1,
      auth: { role: "operator", scopes: ["operator.admin"] },
      features: { methods: ["openclaw.chat"] },
    },
    assistantAgentId: "main",
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  const listeners = new Set<(snapshot: ApplicationGatewaySnapshot) => void>();
  const eventListeners = new Set<GatewayEventListener>();
  const connection = {
    gatewayUrl: "ws://gateway.test/control",
    token: "",
    bootstrapToken: "",
    password: "",
  };
  const gateway = {
    get snapshot() {
      return snapshot;
    },
    connection,
    subscribe: (listener: (snapshot: ApplicationGatewaySnapshot) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeEvents: (listener: GatewayEventListener) => {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
  } as unknown as ApplicationGateway;
  const context = {
    gateway,
    basePath: "",
    navigate: vi.fn(),
  } as unknown as ApplicationContext;
  return {
    context,
    setGatewaySnapshot: (patch) => {
      snapshot = { ...snapshot, ...patch };
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
    setGatewayUrl: (gatewayUrl) => {
      connection.gatewayUrl = gatewayUrl;
    },
    setGatewayToken: (token: string) => {
      connection.token = token;
    },
    setGatewayBootstrapToken: (value: string) => {
      connection.bootstrapToken = value;
    },
    setGatewayDeviceToken: (deviceToken: string) => {
      snapshot = {
        ...snapshot,
        hello: snapshot.hello
          ? { ...snapshot.hello, auth: { ...snapshot.hello.auth, deviceToken } }
          : snapshot.hello,
      };
    },
    emitGatewayEvent: (event) => {
      for (const listener of eventListeners) {
        listener(event as GatewayEventFrame);
      }
    },
  };
}

async function mountPage(
  context: ApplicationContext,
  options: { onboarding?: boolean } = {},
): Promise<{
  page: TestCustodianPage;
  provider: ApplicationContextProvider;
}> {
  const provider = createApplicationContextProvider(context);
  const page = document.createElement("openclaw-custodian-page") as TestCustodianPage;
  page.onboarding = options.onboarding ?? true;
  provider.append(page);
  document.body.append(provider);
  await page.updateComplete;
  return { page, provider };
}

describe("custodian page", () => {
  beforeEach(() => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("starts onboarding chat, renders typed choices, and sends the option reply", async () => {
    const question = {
      id: "onboarding-next-step",
      header: "Next step",
      question: "What would you like to do first?",
      options: [
        {
          label: "Talk to my agent",
          reply: "talk to agent",
          description: "Meet your agent.",
          recommended: true,
        },
        { label: "Connect WhatsApp", reply: "connect whatsapp" },
      ],
      isOther: true,
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
        reply: "Welcome **aboard**.",
        action: "none",
        question,
      })
      .mockResolvedValueOnce({
        sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
        reply: "Connecting WhatsApp.",
        action: "none",
      });
    const { context } = createContext(request);
    const { page } = await mountPage(context);

    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    await page.updateComplete;
    const assistantGroup = page.querySelector<HTMLElement>(".chat-group.assistant")!;
    expect(assistantGroup.querySelector("strong")?.textContent).toBe("aboard");
    expect(assistantGroup.querySelector(".chat-avatar.assistant")?.textContent?.trim()).toBe("OC");
    const card = page.querySelector("openclaw-option-card")!;
    await card.updateComplete;
    expect(page.querySelector(".option-card__choice--recommended")?.textContent).toContain(
      "Talk to my agent",
    );
    const connectOption = page.querySelectorAll<HTMLButtonElement>("[data-option-value]")[1]!;
    connectOption.click();

    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    await page.updateComplete;
    expect(request.mock.calls[0]?.[0]).toBe("openclaw.chat");
    expect(request.mock.calls[0]?.[1]).toMatchObject({ welcomeVariant: "onboarding" });
    // The engine receives the parseable reply text; the transcript shows the label.
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      welcomeVariant: "onboarding",
      message: "connect whatsapp",
    });
    const userGroup = page.querySelector<HTMLElement>(".chat-group.user")!;
    expect(userGroup.textContent).toContain("Connect WhatsApp");
    expect(connectOption.disabled).toBe(true);
  });

  it("keeps failed sensitive replies masked for correction and retry", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
        reply: "Enter the token.",
        sensitive: true,
        action: "none",
      })
      .mockRejectedValueOnce(new Error("Request failed"));
    const { context } = createContext(request);
    const { page } = await mountPage(context);
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    await page.updateComplete;
    const input = page.querySelector<HTMLInputElement>(
      '.agent-chat__composer-combobox input[type="password"]',
    )!;
    input.value = "test-token-placeholder";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await page.updateComplete;
    page.querySelector<HTMLButtonElement>(".chat-send-btn")!.click();

    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    await waitForFast(() => expect(page.querySelector('[role="alert"]')).not.toBeNull());
    await page.updateComplete;
    expect(input.isConnected).toBe(true);
    expect(page.textContent).toContain("Sensitive reply sent");
    expect(page.innerHTML).not.toContain("test-token-placeholder");
  });

  it("preserves the onboarding session across a same-gateway reconnect", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
      reply: "Hello from OpenClaw.",
      action: "none",
    });
    const { context, setGatewaySnapshot } = createContext(request);
    const { page } = await mountPage(context);
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    await page.updateComplete;

    setGatewaySnapshot({ client: null, connected: false, reconnecting: true });
    await page.updateComplete;
    setGatewaySnapshot({
      client: { request } as unknown as GatewayBrowserClient,
      connected: true,
      reconnecting: false,
    });
    await page.updateComplete;

    expect(request).toHaveBeenCalledOnce();
    expect(page.textContent).toContain("Hello from OpenClaw.");
  });

  it("keeps the device-token session scope while hello is gone during a drop", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
      reply: "Device-token conversation.",
      action: "none",
    });
    const { context, setGatewaySnapshot, setGatewayDeviceToken } = createContext(request);
    setGatewayDeviceToken("stored-device-token");
    const { page } = await mountPage(context);
    await waitForFast(() => expect(page.textContent).toContain("Device-token conversation."));

    // Transient drop: the retrying client stays but hello is cleared.
    setGatewaySnapshot({ client: null, connected: false, reconnecting: true, hello: null });
    await page.updateComplete;
    setGatewaySnapshot({
      client: { request } as unknown as GatewayBrowserClient,
      connected: true,
      reconnecting: false,
      hello: {
        type: "hello-ok" as const,
        protocol: 1,
        auth: { role: "operator", scopes: ["operator.admin"], deviceToken: "stored-device-token" },
        features: { methods: ["openclaw.chat"] },
      } as ApplicationGatewaySnapshot["hello"],
    });
    await page.updateComplete;

    expect(request).toHaveBeenCalledOnce();
    expect(page.textContent).toContain("Device-token conversation.");
  });

  it("offers retry when a connected client is replaced mid-request", async () => {
    const request = vi
      .fn()
      .mockReturnValueOnce(
        new Promise<never>(() => {
          // Keep the original request pending while the gateway replaces its client.
        }),
      )
      .mockResolvedValueOnce({
        sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
        reply: "Hello after reconnect.",
        action: "none",
      });
    const { context, setGatewaySnapshot } = createContext(request);
    const { page } = await mountPage(context);
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());

    setGatewaySnapshot({ client: { request } as unknown as GatewayBrowserClient });
    await waitForFast(() =>
      expect(page.querySelector('[role="alert"]')?.textContent).toContain(
        "Gateway connection changed",
      ),
    );
    page.querySelector<HTMLButtonElement>('[role="alert"] button')!.click();
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    await waitForFast(() => expect(page.textContent).toContain("Hello after reconnect."));
  });

  it("clears the prior conversation when the gateway changes while offline", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
      reply: "Gateway A conversation.",
      action: "none",
    });
    const { context, setGatewaySnapshot, setGatewayUrl } = createContext(request);
    const { page } = await mountPage(context);
    await waitForFast(() => expect(page.textContent).toContain("Gateway A conversation."));

    setGatewayUrl("ws://gateway-b.test/control");
    setGatewaySnapshot({ client: null, connected: false, reconnecting: true });
    await waitForFast(() => expect(page.textContent).not.toContain("Gateway A conversation."));

    expect(page.querySelector('[role="alert"] button')).toBeNull();
  });

  it("starts a fresh session when credentials change on the same gateway", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
        reply: "Operator A conversation.",
        action: "none",
      })
      .mockResolvedValueOnce({
        sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
        reply: "Operator B welcome.",
        action: "none",
      });
    const { context, setGatewaySnapshot, setGatewayToken } = createContext(request);
    const { page } = await mountPage(context);
    await waitForFast(() => expect(page.textContent).toContain("Operator A conversation."));

    setGatewayToken("test-token-placeholder");
    setGatewaySnapshot({
      client: { request } as unknown as GatewayBrowserClient,
      connected: true,
      reconnecting: false,
    });

    await waitForFast(() => expect(page.textContent).toContain("Operator B welcome."));
    expect(page.textContent).not.toContain("Operator A conversation.");
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[1]).toMatchObject({ welcomeVariant: "onboarding" });
    expect(request.mock.calls[1]?.[1]).not.toHaveProperty("message");
  });

  it("starts a fresh session when a bootstrap token re-pairs the same gateway", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
        reply: "Paired device conversation.",
        action: "none",
      })
      .mockResolvedValue({
        sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
        reply: "Re-paired welcome.",
        action: "none",
      });
    const { context, setGatewaySnapshot, setGatewayBootstrapToken } = createContext(request);
    const { page } = await mountPage(context);
    await waitForFast(() => expect(page.textContent).toContain("Paired device conversation."));

    setGatewayBootstrapToken("test-token-placeholder");
    setGatewaySnapshot({
      client: { request } as unknown as GatewayBrowserClient,
      connected: true,
      reconnecting: false,
    });

    await waitForFast(() => expect(page.textContent).toContain("Re-paired welcome."));
    expect(page.textContent).not.toContain("Paired device conversation.");
  });

  it("starts a fresh session when stored device auth changes on the same gateway", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
        reply: "Device A conversation.",
        action: "none",
      })
      .mockResolvedValueOnce({
        sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
        reply: "Device B welcome.",
        action: "none",
      });
    const { context, setGatewaySnapshot, setGatewayDeviceToken } = createContext(request);
    const { page } = await mountPage(context);
    await waitForFast(() => expect(page.textContent).toContain("Device A conversation."));

    setGatewayDeviceToken("test-token-placeholder");
    setGatewaySnapshot({
      client: { request } as unknown as GatewayBrowserClient,
      connected: true,
      reconnecting: false,
    });

    await waitForFast(() => expect(page.textContent).toContain("Device B welcome."));
    expect(page.textContent).not.toContain("Device A conversation.");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("clears a pending sensitive turn when stored device auth changes", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
        reply: "Paste your token.",
        sensitive: true,
        action: "none",
      })
      .mockReturnValueOnce(
        new Promise<never>(() => {
          // Keep the sensitive turn pending across the credential change.
        }),
      )
      .mockResolvedValueOnce({
        sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
        reply: "New operator welcome.",
        action: "none",
      });
    const { context, setGatewaySnapshot, setGatewayDeviceToken } = createContext(request);
    const { page } = await mountPage(context);
    await waitForFast(() => expect(page.textContent).toContain("Paste your token."));

    const composer = page.querySelector<HTMLInputElement>('input[type="password"]')!;
    composer.value = "test-token-placeholder";
    composer.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await page.updateComplete;
    page.querySelector<HTMLButtonElement>(".chat-send-btn")!.click();
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));

    setGatewayDeviceToken("test-token-placeholder");
    setGatewaySnapshot({
      client: { request } as unknown as GatewayBrowserClient,
      connected: true,
      reconnecting: false,
    });

    await waitForFast(() => expect(page.textContent).toContain("New operator welcome."));
    expect(page.textContent).not.toContain("Paste your token.");
    expect(page.textContent).not.toContain("Sensitive reply sent");
    expect(page.querySelector('[role="alert"]')).toBeNull();
    expect(page.innerHTML).not.toContain("test-token-placeholder");
  });

  it("does not offer replay for a failed user turn", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
        reply: "Welcome.",
        action: "none",
      })
      .mockRejectedValueOnce(new Error("gateway timeout"));
    const { context } = createContext(request);
    const { page } = await mountPage(context);
    await waitForFast(() => expect(page.textContent).toContain("Welcome."));

    const composer = page.querySelector<HTMLTextAreaElement>("textarea")!;
    composer.value = "install everything";
    composer.dispatchEvent(new Event("input"));
    await page.updateComplete;
    page.querySelector<HTMLButtonElement>(".chat-send-btn")!.click();

    await waitForFast(() =>
      expect(page.querySelector('[role="alert"]')?.textContent).toContain("gateway timeout"),
    );
    expect(page.querySelector('[role="alert"] button')).toBeNull();
  });

  it("sends sensitive input verbatim and masks it in the transcript", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
        reply: "Paste your API key.",
        action: "none",
        sensitive: true,
      })
      .mockResolvedValueOnce({
        sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
        reply: "Key accepted.",
        action: "none",
      });
    const { context } = createContext(request);
    const { page } = await mountPage(context);
    await waitForFast(() => expect(page.textContent).toContain("Paste your API key."));

    const composer = page.querySelector<HTMLInputElement>('input[type="password"]')!;
    const sensitiveValue = ["", "test-token-placeholder", ""].join(" ");
    composer.value = sensitiveValue;
    composer.dispatchEvent(new Event("input"));
    await page.updateComplete;
    page.querySelector<HTMLButtonElement>(".chat-send-btn")!.click();

    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[1]?.[1]).toMatchObject({ message: sensitiveValue });
    await waitForFast(() => expect(page.textContent).toContain("Key accepted."));
    expect(page.textContent).not.toContain("test-token-placeholder");
  });

  it("sends skip as a reply and dismisses the question", async () => {
    const question = {
      id: "access",
      header: "Access",
      question: "How should OpenClaw work?",
      options: [{ label: "Full access", recommended: true }, { label: "Ask first" }],
      isOther: false,
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
        reply: "Choose one.",
        action: "none",
        question,
      })
      .mockResolvedValueOnce({
        sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
        reply: "Moving on.",
        action: "none",
      });
    const { context } = createContext(request);
    const { page } = await mountPage(context);
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    await page.updateComplete;

    page.querySelector<HTMLButtonElement>(".option-card__skip")!.click();

    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    await page.updateComplete;
    expect(request.mock.calls[1]?.[1]).toMatchObject({ message: "Skip for now" });
    expect(page.querySelector("openclaw-option-card")).toBeNull();
  });

  it("retires a structured question after a freeform reply", async () => {
    const question = {
      id: "access",
      header: "Access",
      question: "How should OpenClaw work?",
      options: [{ label: "Full access", recommended: true }, { label: "Ask first" }],
      isOther: false,
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
        reply: "Choose one.",
        action: "none",
        question,
      })
      .mockResolvedValueOnce({
        sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
        reply: "Understood.",
        action: "none",
      });
    const { context } = createContext(request);
    const { page } = await mountPage(context);
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    await page.updateComplete;
    const input = page.querySelector<HTMLTextAreaElement>(
      ".agent-chat__composer-combobox textarea",
    )!;
    input.value = "**Something** else";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await page.updateComplete;

    page.querySelector<HTMLButtonElement>(".chat-send-btn")!.click();

    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    await page.updateComplete;
    expect(request.mock.calls[1]?.[1]).toMatchObject({ message: "**Something** else" });
    // Parity with the regular chat: user turns run through the same markdown pipeline.
    const sentGroup = page.querySelector<HTMLElement>(".chat-group.user")!;
    expect(sentGroup.querySelector("strong")?.textContent).toBe("Something");
    expect(page.querySelector<HTMLButtonElement>('[data-option-value="Ask first"]')?.disabled).toBe(
      true,
    );
  });

  it("requests the normal caretaker greeting outside onboarding", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
      reply: "OpenClaw here. Everything is healthy.",
      action: "none",
    });
    const { context } = createContext(request);
    const { page } = await mountPage(context, { onboarding: false });
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    await page.updateComplete;

    // The onboarding variant seeds the first-run setup proposal; permanent
    // presence visits must not re-enter that flow.
    expect(request.mock.calls[0]?.[1]).not.toHaveProperty("welcomeVariant");

    const composer = page.querySelector<HTMLTextAreaElement>("textarea")!;
    composer.value = "status";
    composer.dispatchEvent(new Event("input"));
    await page.updateComplete;
    page.querySelector<HTMLButtonElement>(".chat-send-btn")!.click();
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[1]?.[1]).not.toHaveProperty("welcomeVariant");
    expect(request.mock.calls[1]?.[1]).toMatchObject({ message: "status" });
  });

  it("shows a channel-error nudge but ignores routine events", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
      reply: "Everything is healthy.",
      action: "none",
    });
    const { context, emitGatewayEvent } = createContext(request);
    const { page } = await mountPage(context, { onboarding: false });
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());

    emitGatewayEvent({ event: "tick", payload: { ts: Date.now() } });
    await page.updateComplete;
    expect(page.querySelector(".custodian__nudge")).toBeNull();

    emitGatewayEvent({
      event: "health",
      payload: {
        channels: {
          telegram: {
            enabled: false,
            accounts: {
              default: {
                configured: true,
                enabled: false,
                running: true,
                connected: false,
              },
            },
          },
        },
      },
    });
    await page.updateComplete;
    expect(page.querySelector(".custodian__nudge")).toBeNull();

    emitGatewayEvent({
      event: "health",
      payload: {
        channelLabels: { telegram: "Telegram" },
        channels: {
          telegram: {
            enabled: false,
            accounts: {
              default: { configured: true, enabled: false, connected: false },
              work: { configured: true, enabled: true, running: true, connected: false },
            },
          },
        },
      },
    });
    await page.updateComplete;
    expect(page.querySelector(".custodian__nudge")?.textContent).toContain(
      "Telegram just disconnected",
    );
  });

  it("does not report an intentionally stopped channel as disconnected", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
      reply: "Everything is healthy.",
      action: "none",
    });
    const { context, emitGatewayEvent } = createContext(request);
    const { page } = await mountPage(context, { onboarding: false });
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());

    emitGatewayEvent({
      event: "health",
      payload: {
        channels: {
          telegram: {
            configured: true,
            enabled: true,
            running: false,
            connected: false,
            healthState: "not-running",
            restartPending: false,
            reconnectAttempts: 0,
            lastStopAt: 1_700_000_000_000,
            lastError: "connection closed during the previous run",
          },
        },
      },
    });
    await page.updateComplete;
    expect(page.querySelector(".custodian__nudge")).toBeNull();
  });

  it("does not report a recovered channel with a retained error", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
      reply: "Everything is healthy.",
      action: "none",
    });
    const { context, emitGatewayEvent } = createContext(request);
    const { page } = await mountPage(context, { onboarding: false });
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());

    emitGatewayEvent({
      event: "health",
      payload: {
        channels: {
          telegram: {
            configured: true,
            enabled: true,
            running: true,
            healthState: "healthy",
            lastError: "connection closed during the previous run",
          },
        },
      },
    });
    await page.updateComplete;
    expect(page.querySelector(".custodian__nudge")).toBeNull();
  });

  it("reports a channel that fails before its first start", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
      reply: "Everything is healthy.",
      action: "none",
    });
    const { context, emitGatewayEvent } = createContext(request);
    const { page } = await mountPage(context, { onboarding: false });
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());

    emitGatewayEvent({
      event: "health",
      payload: {
        channelLabels: { telegram: "Telegram" },
        channels: {
          telegram: {
            configured: true,
            enabled: true,
            running: false,
            connected: false,
            restartPending: false,
            reconnectAttempts: 0,
            healthState: "not-running",
            lastError: "failed to initialize transport",
          },
        },
      },
    });
    await page.updateComplete;
    expect(page.querySelector(".custodian__nudge")?.textContent).toContain("Telegram is degraded");
  });

  it("reports a failed restart after an earlier clean stop", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
      reply: "Everything is healthy.",
      action: "none",
    });
    const { context, emitGatewayEvent } = createContext(request);
    const { page } = await mountPage(context, { onboarding: false });
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());

    emitGatewayEvent({
      event: "health",
      payload: {
        channelLabels: { telegram: "Telegram" },
        channels: {
          telegram: {
            configured: true,
            enabled: true,
            running: false,
            restartPending: false,
            reconnectAttempts: 0,
            healthState: "not-running",
            lastStopAt: 1_700_000_000_000,
            lastStartAt: 1_700_000_001_000,
            lastError: "failed to initialize transport",
          },
        },
      },
    });
    await page.updateComplete;
    expect(page.querySelector(".custodian__nudge")?.textContent).toContain("Telegram is degraded");
  });

  it("reports a current failed probe for an intentionally stopped channel", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
      reply: "Everything is healthy.",
      action: "none",
    });
    const { context, emitGatewayEvent } = createContext(request);
    const { page } = await mountPage(context, { onboarding: false });
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());

    emitGatewayEvent({
      event: "health",
      payload: {
        channelLabels: { telegram: "Telegram" },
        channels: {
          telegram: {
            configured: true,
            enabled: true,
            running: false,
            restartPending: false,
            reconnectAttempts: 0,
            healthState: "not-running",
            lastStopAt: 1_700_000_001_000,
            lastStartAt: 1_700_000_000_000,
            probe: { ok: false },
          },
        },
      },
    });
    await page.updateComplete;
    expect(page.querySelector(".custodian__nudge")?.textContent).toContain("Telegram is degraded");
  });

  it("shows a channel disconnect from the aggregate health row", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
      reply: "Everything is healthy.",
      action: "none",
    });
    const { context, emitGatewayEvent } = createContext(request);
    const { page } = await mountPage(context, { onboarding: false });
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());

    emitGatewayEvent({
      event: "health",
      payload: {
        channelLabels: { telegram: "Telegram" },
        channels: {
          telegram: { configured: true, running: true, connected: false },
        },
      },
    });
    await page.updateComplete;

    expect(page.querySelector(".custodian__nudge")?.textContent).toContain(
      "Telegram just disconnected",
    );
  });

  it("clears a pending event nudge when the gateway identity changes", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
      reply: "Everything is healthy.",
      action: "none",
    });
    const { context, emitGatewayEvent, setGatewaySnapshot, setGatewayUrl } = createContext(request);
    const { page } = await mountPage(context, { onboarding: false });
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());

    emitGatewayEvent({
      event: "health",
      payload: {
        channels: { telegram: { configured: true, running: true, connected: false } },
      },
    });
    await page.updateComplete;
    expect(page.querySelector(".custodian__nudge")).not.toBeNull();

    setGatewayUrl("ws://gateway-b.test/control");
    setGatewaySnapshot({
      client: { request } as unknown as GatewayBrowserClient,
      connected: true,
      reconnecting: false,
    });
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    await page.updateComplete;
    expect(page.querySelector(".custodian__nudge")).toBeNull();

    emitGatewayEvent({
      event: "health",
      payload: { configReload: { hotReloadStatus: "disabled" }, channels: {} },
    });
    await page.updateComplete;
    expect(page.querySelector(".custodian__nudge")?.textContent).toContain(
      "Configuration reload stopped",
    );
  });

  it("dismisses event nudges for the rest of the page visit", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
      reply: "Everything is healthy.",
      action: "none",
    });
    const { context, emitGatewayEvent } = createContext(request);
    const { page } = await mountPage(context, { onboarding: false });
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());

    emitGatewayEvent({
      event: "health",
      payload: {
        channels: { telegram: { configured: true, running: true, connected: false } },
      },
    });
    await page.updateComplete;
    page.querySelector<HTMLButtonElement>(".custodian__nudge-dismiss")!.click();
    await page.updateComplete;

    emitGatewayEvent({
      event: "health",
      payload: { configReload: { hotReloadStatus: "disabled" }, channels: {} },
    });
    await page.updateComplete;
    expect(page.querySelector(".custodian__nudge")).toBeNull();
    expect(request).toHaveBeenCalledOnce();
  });

  it("replaces a pending nudge only with a more severe event", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
      reply: "Everything is healthy.",
      action: "none",
    });
    const { context, emitGatewayEvent } = createContext(request);
    const { page } = await mountPage(context, { onboarding: false });
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());

    emitGatewayEvent({
      event: "health",
      payload: {
        channelLabels: { telegram: "Telegram" },
        channels: { telegram: { configured: true, healthState: "stale-socket" } },
      },
    });
    await page.updateComplete;
    expect(page.querySelector(".custodian__nudge")?.textContent).toContain("Telegram is degraded");

    emitGatewayEvent({
      event: "health",
      payload: {
        channelLabels: { discord: "Discord" },
        channels: { discord: { configured: true, healthState: "stale-socket" } },
      },
    });
    await page.updateComplete;
    expect(page.querySelector(".custodian__nudge")?.textContent).toContain("Telegram is degraded");

    emitGatewayEvent({
      event: "health",
      payload: {
        channelLabels: { discord: "Discord" },
        channels: { discord: { configured: true, running: true, connected: false } },
      },
    });
    await page.updateComplete;
    expect(page.querySelector(".custodian__nudge")?.textContent).toContain(
      "Discord just disconnected",
    );
  });

  it("sends a real message when an event nudge is clicked", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
      reply: "Everything is healthy.",
      action: "none",
    });
    const { context, emitGatewayEvent } = createContext(request);
    const { page } = await mountPage(context, { onboarding: false });
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());

    emitGatewayEvent({
      event: "health",
      payload: {
        channels: {
          telegram: { configured: true, tokenStatus: "configured_unavailable" },
        },
      },
    });
    await page.updateComplete;
    page.querySelector<HTMLButtonElement>(".custodian__nudge-action")!.click();

    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      message: "what happened with telegram authentication?",
    });
    expect(page.textContent).toContain("what happened with telegram authentication?");
    expect(page.querySelector(".custodian__nudge")).toBeNull();
  });

  it("never shows event nudges during onboarding", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
      reply: "Welcome.",
      action: "none",
    });
    const { context, emitGatewayEvent } = createContext(request);
    const { page } = await mountPage(context, { onboarding: true });
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());

    emitGatewayEvent({
      event: "health",
      payload: { configReload: { hotReloadStatus: "disabled" }, channels: {} },
    });
    await page.updateComplete;

    expect(page.querySelector(".custodian__nudge")).toBeNull();
  });

  it("starts a fresh welcome when onboarding mode changes", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
        reply: "Normal caretaker conversation.",
        action: "none",
      })
      .mockResolvedValueOnce({
        sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
        reply: "Onboarding proposal.",
        action: "none",
      });
    const { context } = createContext(request);
    const { page } = await mountPage(context, { onboarding: false });
    await waitForFast(() => expect(page.textContent).toContain("Normal caretaker conversation."));

    page.onboarding = true;
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    await waitForFast(() => expect(page.textContent).toContain("Onboarding proposal."));

    expect(page.textContent).not.toContain("Normal caretaker conversation.");
    expect(request.mock.calls[1]?.[1]).toMatchObject({ welcomeVariant: "onboarding" });
    expect(request.mock.calls[1]?.[1]).not.toHaveProperty("message");
  });

  it("hands off to agent chat with the hatch draft on open-agent", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
      reply: "Your agent is hatching — handing you over now.",
      action: "open-agent",
      agentDraft: "hatch",
    });
    const { context } = createContext(request);
    const { page } = await mountPage(context);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    await page.updateComplete;

    expect(context.navigate).toHaveBeenCalledWith("chat", {
      search: `?session=main&draft=${encodeURIComponent("Wake up, my friend!")}`,
    });
  });

  it("hands off to normal agent chat without the hatch draft", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
      reply: "Setup here is done — continue with your agent.",
      action: "open-agent",
    });
    const { context } = createContext(request);
    await mountPage(context);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());

    expect(context.navigate).toHaveBeenCalledWith("chat");
  });

  it("exits setup through normal chat navigation", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
      reply: "Hello.",
      action: "none",
    });
    const { context } = createContext(request);
    const { page } = await mountPage(context);
    page.onboarding = true;
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    await page.updateComplete;

    page.querySelector<HTMLButtonElement>(".custodian__header button")!.click();

    expect(context.navigate).toHaveBeenCalledWith("chat");
  });
});
