/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createContext, mountPage } from "./custodian-page.test-harness.ts";

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

  it("renders advertised durable history before the live welcome with a divider", async () => {
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "openclaw.chat.history") {
        return {
          turns: [
            { role: "user", text: "Earlier question", at: 1 },
            { role: "assistant", text: "Earlier answer", at: 2 },
          ],
        };
      }
      if (method === "openclaw.chat") {
        return {
          sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
          reply: "Live welcome",
          action: "none",
        };
      }
      throw new Error(`unexpected request ${method}`);
    });
    const { context } = createContext(request, ["openclaw.chat", "openclaw.chat.history"]);
    const { page } = await mountPage(context);

    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    await page.updateComplete;

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "openclaw.chat.history",
      "openclaw.chat",
    ]);
    expect(request.mock.calls[0]?.[1]).toEqual({});
    const rows = Array.from(page.querySelectorAll(".chat-group, .chat-divider")).map((row) =>
      row.textContent?.trim(),
    );
    expect(rows).toEqual([
      expect.stringContaining("Earlier question"),
      expect.stringContaining("Earlier answer"),
      expect.stringContaining("Earlier"),
      expect.stringContaining("Live welcome"),
    ]);
  });

  it("continues to the welcome when the bounded history request times out", async () => {
    const request = vi.fn(
      async (method: string, _params?: unknown, options?: { timeoutMs?: number }) => {
        if (method === "openclaw.chat.history") {
          expect(options).toEqual({ timeoutMs: 15_000 });
          throw new Error("history request timed out");
        }
        return {
          sessionId: "engine-session-after-history-timeout",
          reply: "Welcome without history.",
          action: "none",
        };
      },
    );
    const { context } = createContext(request, ["openclaw.chat", "openclaw.chat.history"]);
    const { page } = await mountPage(context);

    await waitForFast(() => expect(page.textContent).toContain("Welcome without history."));
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "openclaw.chat.history",
      "openclaw.chat",
    ]);
  });

  it("keeps rows for a same-ownership client replacement and requests a fresh welcome", async () => {
    let chatCalls = 0;
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "openclaw.chat.history") {
        return { turns: [{ role: "assistant", text: "Earlier state", at: 1 }] };
      }
      if (method === "openclaw.chat") {
        chatCalls += 1;
        return {
          sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
          reply: chatCalls === 1 ? "Live welcome" : "Fresh session welcome",
          action: "none",
        };
      }
      throw new Error(`unexpected request ${method}`);
    });
    const { context, setGatewaySnapshot } = createContext(request, [
      "openclaw.chat",
      "openclaw.chat.history",
    ]);
    const { page } = await mountPage(context);
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));

    setGatewaySnapshot({ client: { request } as unknown as GatewayBrowserClient });
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(3));
    await waitForFast(() => expect(page.textContent).toContain("Fresh session welcome"));

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "openclaw.chat.history",
      "openclaw.chat",
      "openclaw.chat",
    ]);
    expect(request.mock.calls[2]?.[1]).toMatchObject({
      sessionId: expect.stringMatching(/^control-ui-onboarding-/),
    });
    expect(page.textContent).toContain("Earlier state");
    expect(page.textContent).toContain("Fresh session welcome");
  });

  it("does not rotate against a replacement gateway without chat support", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "engine-session-before-replacement",
      reply: "Existing welcome.",
      action: "none",
    });
    const replacementRequest = vi.fn();
    const { context, setGatewaySnapshot } = createContext(request);
    const { page } = await mountPage(context);
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());

    setGatewaySnapshot({
      client: { request: replacementRequest } as unknown as GatewayBrowserClient,
      hello: {
        type: "hello-ok",
        protocol: 1,
        auth: { role: "operator", scopes: ["operator.admin"] },
        features: { methods: [] },
      },
    });
    await waitForFast(() =>
      expect(page.querySelector('[role="alert"]')?.textContent).toContain("Update the Gateway"),
    );

    expect(request).toHaveBeenCalledOnce();
    expect(replacementRequest).not.toHaveBeenCalled();
  });

  it("keeps loaded transcript rows when a welcome retry cannot refresh them", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        turns: [{ role: "assistant", text: "Loaded transcript row", at: 1 }],
      })
      .mockRejectedValueOnce(new Error("temporary welcome failure"))
      .mockRejectedValueOnce(new Error("temporary history failure"))
      .mockResolvedValueOnce({
        sessionId: "engine-session-after-retry",
        reply: "Recovered welcome.",
        action: "none",
      });
    const { context } = createContext(request, ["openclaw.chat", "openclaw.chat.history"]);
    const { page } = await mountPage(context);
    await waitForFast(() => expect(page.querySelector('[role="alert"] button')).not.toBeNull());

    page.querySelector<HTMLButtonElement>('[role="alert"] button')!.click();
    await waitForFast(() => expect(page.textContent).toContain("Recovered welcome."));

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "openclaw.chat.history",
      "openclaw.chat",
      "openclaw.chat.history",
      "openclaw.chat",
    ]);
    expect(page.textContent).toContain("Loaded transcript row");
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

  it("keeps an unanswered structured question across a same-client reconnect", async () => {
    const question = {
      id: "reconnect-choice",
      header: "Next step",
      question: "What should happen next?",
      options: [{ label: "Continue" }, { label: "Pause" }],
      isOther: false,
    };
    const request = vi.fn(async (method: string) => {
      if (method === "openclaw.chat.history") {
        return { turns: [{ role: "assistant", text: "Earlier row", at: 1 }] };
      }
      return {
        sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
        reply: "Choose the next step.",
        question,
        action: "none",
      };
    });
    const { context, setGatewaySnapshot } = createContext(request, [
      "openclaw.chat",
      "openclaw.chat.history",
    ]);
    const { page } = await mountPage(context);
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    await page.updateComplete;
    expect(page.querySelector("openclaw-option-card")).not.toBeNull();

    setGatewaySnapshot({ connected: false, reconnecting: true });
    await page.updateComplete;
    setGatewaySnapshot({
      connected: true,
      reconnecting: false,
    });
    await page.updateComplete;

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "openclaw.chat.history",
      "openclaw.chat",
    ]);
    expect(page.querySelector("openclaw-option-card")).not.toBeNull();
    expect(page.textContent).toContain("Choose the next step.");
  });

  it("requests a fresh welcome when a connected client is replaced mid-request", async () => {
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
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    await waitForFast(() => expect(page.textContent).toContain("Hello after reconnect."));
    expect(page.querySelector('[role="alert"]')).toBeNull();
  });

  it("warns without offering replay when a client replacement abandons a user turn", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "engine-session-before-user-turn",
        reply: "Welcome.",
        action: "none",
      })
      .mockReturnValueOnce(
        new Promise<never>(() => {
          // The user turn may reach the old gateway before its client is replaced.
        }),
      )
      .mockResolvedValueOnce({
        sessionId: "engine-session-after-user-turn",
        reply: "Fresh welcome.",
        action: "none",
      });
    const { context, setGatewaySnapshot } = createContext(request);
    const { page } = await mountPage(context);
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());

    const composer = page.querySelector<HTMLTextAreaElement>("textarea")!;
    composer.value = "check this system";
    composer.dispatchEvent(new Event("input"));
    await page.updateComplete;
    page.querySelector<HTMLButtonElement>(".chat-send-btn")!.click();
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));

    setGatewaySnapshot({ client: { request } as unknown as GatewayBrowserClient });
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(3));
    await waitForFast(() =>
      expect(page.querySelector('[role="alert"]')?.textContent).toContain(
        "The Gateway connection changed",
      ),
    );

    expect(request.mock.calls[2]?.[1]).not.toHaveProperty("message");
    expect(page.querySelector('[role="alert"] button')).toBeNull();
  });

  it("clears stale rows and cold-starts against the new gateway after credentials change", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        turns: [{ role: "assistant", text: "Old gateway transcript", at: 1 }],
      })
      .mockResolvedValueOnce({
        sessionId: "engine-session-before-rotation",
        reply: "Enter the token.",
        sensitive: true,
        action: "none",
      })
      .mockReturnValueOnce(
        new Promise<never>(() => {
          // Keep the sensitive turn pending while the gateway replaces its client.
        }),
      );
    const replacementRequest = vi
      .fn()
      .mockResolvedValueOnce({
        turns: [{ role: "assistant", text: "New gateway transcript", at: 2 }],
      })
      .mockResolvedValueOnce({
        sessionId: "engine-session-after-rotation",
        reply: "Fresh safe welcome.",
        action: "none",
      });
    const { context, setGatewaySnapshot, setGatewayToken } = createContext(request, [
      "openclaw.chat",
      "openclaw.chat.history",
    ]);
    const { page } = await mountPage(context);
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));

    const input = page.querySelector<HTMLInputElement>(
      '.agent-chat__composer-combobox input[type="password"]',
    )!;
    input.value = "test-token-placeholder";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await page.updateComplete;
    page.querySelector<HTMLButtonElement>(".chat-send-btn")!.click();
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(3));

    setGatewayToken("new-operator-token");
    setGatewaySnapshot({
      client: { request: replacementRequest } as unknown as GatewayBrowserClient,
    });
    await waitForFast(() => expect(replacementRequest).toHaveBeenCalledTimes(2));
    await waitForFast(() => expect(page.textContent).toContain("Fresh safe welcome."));

    expect(request.mock.calls[2]?.[1]).toMatchObject({
      sessionId: "engine-session-before-rotation",
      message: "test-token-placeholder",
    });
    expect(replacementRequest.mock.calls.map(([method]) => method)).toEqual([
      "openclaw.chat.history",
      "openclaw.chat",
    ]);
    expect(replacementRequest.mock.calls[1]?.[1]).toMatchObject({
      sessionId: expect.stringMatching(/^control-ui-onboarding-/),
    });
    expect(replacementRequest.mock.calls[1]?.[1]).not.toHaveProperty("message");
    expect(replacementRequest.mock.calls[1]?.[1]).not.toMatchObject({
      sessionId: "engine-session-before-rotation",
    });
    expect(page.textContent).not.toContain("Old gateway transcript");
    expect(page.textContent).not.toContain("Enter the token.");
    expect(page.textContent).not.toContain("Sensitive reply sent");
    expect(page.textContent).toContain("New gateway transcript");
    expect(page.querySelector('input[type="password"]')).toBeNull();
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

  it("sends a wizard-parseable cancel reply when skipping a closed question", async () => {
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
    expect(request.mock.calls[1]?.[1]).toMatchObject({ message: "cancel" });
    expect(page.querySelector(".chat-group.user")?.textContent).toContain("Skip for now");
    await waitForFast(() => expect(page.querySelector("openclaw-option-card")).toBeNull());
  });

  it("exits onboarding locally when the question declares an exit skip action", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
      reply: "What would you like to do first?",
      action: "none",
      question: {
        id: "onboarding-next-step",
        header: "Next step",
        question: "What would you like to do first?",
        options: [{ label: "Talk to my agent" }, { label: "Connect a channel" }],
        isOther: true,
        skipAction: "exit",
      },
    });
    const { context } = createContext(request);
    const { page } = await mountPage(context);
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    await page.updateComplete;

    page.querySelector<HTMLButtonElement>(".option-card__skip")!.click();

    expect(context.navigate).toHaveBeenCalledWith("chat");
    expect(request).toHaveBeenCalledOnce();
  });

  it("does not render a silent assistant reply", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
      reply: " NO_REPLY ",
      action: "none",
    });
    const { context } = createContext(request);
    const { page } = await mountPage(context);
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    await page.updateComplete;

    expect(page.querySelector(".chat-group.assistant")).toBeNull();
    expect(page.textContent).not.toContain("NO_REPLY");
  });

  it("keeps a structured question attached to a silent assistant reply", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
      reply: "NO_REPLY",
      action: "none",
      question: {
        id: "channel",
        header: "Channel",
        question: "Which channel?",
        options: [{ label: "WhatsApp" }, { label: "Telegram" }],
      },
    });
    const { context } = createContext(request);
    const { page } = await mountPage(context);
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    await page.updateComplete;

    expect(page.querySelector(".chat-group.assistant")).toBeNull();
    expect(page.querySelector("openclaw-option-card")).not.toBeNull();
    expect(page.textContent).toContain("Which channel?");
    expect(page.textContent).not.toContain("NO_REPLY");
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

  it("renders and sends quick actions on the normal caretaker welcome", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "control-ui-caretaker-00000000-0000-4000-8000-000000000001",
        reply: "I'm OpenClaw. All systems nominal.",
        action: "none",
        question: {
          id: "system-agent-quick-actions",
          header: "Quick actions",
          question: "What would you like me to do?",
          options: [
            { label: "Talk to my agent", reply: "talk to agent", recommended: true },
            { label: "Show recent changes", reply: "audit" },
          ],
        },
      })
      .mockResolvedValueOnce({
        sessionId: "control-ui-caretaker-00000000-0000-4000-8000-000000000001",
        reply: "Here's the audit state.",
        action: "none",
      });
    const { context } = createContext(request);
    const { page } = await mountPage(context, { onboarding: false });
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    await page.updateComplete;

    page.querySelector<HTMLButtonElement>('[data-option-value="Show recent changes"]')!.click();

    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[1]?.[1]).toMatchObject({ message: "audit" });
    expect(request.mock.calls[1]?.[1]).not.toHaveProperty("welcomeVariant");
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
