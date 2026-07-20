/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createContext, mountPage } from "./custodian-page.test-harness.ts";

function rejectAfterSend(
  _method: unknown,
  _params: unknown,
  options?: { onSent?: () => void },
): Promise<never> {
  options?.onSent?.();
  return Promise.reject(new Error("Request failed"));
}

describe("custodian page nudges", () => {
  beforeEach(() => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
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

  it("shows configuration reload failures from health snapshots", async () => {
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
      payload: { configReload: { hotReloadStatus: "disabled" }, channels: {} },
    });
    await page.updateComplete;

    expect(page.querySelector(".custodian__nudge")?.textContent).toContain(
      "Configuration reload stopped",
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

  it("keeps a pending event nudge across a transient disconnect and reconnect", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
      reply: "Everything is healthy.",
      action: "none",
    });
    const { context, emitGatewayEvent, setGatewaySnapshot } = createContext(request);
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

    setGatewaySnapshot({ connected: false, reconnecting: true });
    await page.updateComplete;
    expect(page.querySelector(".custodian__nudge")).not.toBeNull();

    setGatewaySnapshot({ connected: true, reconnecting: false });
    await page.updateComplete;
    expect(page.querySelector(".custodian__nudge")).not.toBeNull();
    expect(request).toHaveBeenCalledOnce();
  });

  it("clears a pending event nudge when gateway ownership changes", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
      reply: "Everything is healthy.",
      action: "none",
    });
    const { context, emitGatewayEvent, setGatewaySnapshot, setGatewayToken } =
      createContext(request);
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

    setGatewayToken("new-operator-token");
    setGatewaySnapshot({
      client: { request } as unknown as GatewayBrowserClient,
      connected: true,
      reconnecting: false,
    });
    await waitForFast(() => expect(page.querySelector(".custodian__nudge")).toBeNull());
    expect(request).toHaveBeenCalledTimes(2);

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

  it("replaces a pending nudge with the latest health failure", async () => {
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
    expect(page.querySelector(".custodian__nudge")?.textContent).toContain("Discord is degraded");

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

    emitGatewayEvent({
      event: "health",
      payload: {
        channelLabels: { telegram: "Telegram" },
        channels: { telegram: { configured: true, healthState: "stale-socket" } },
      },
    });
    await page.updateComplete;
    expect(page.querySelector(".custodian__nudge")?.textContent).toContain("Telegram is degraded");
  });

  it("clears a pending nudge when health recovers", async () => {
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
    expect(page.querySelector(".custodian__nudge")).not.toBeNull();

    emitGatewayEvent({
      event: "health",
      payload: {
        channels: { telegram: { configured: true, running: true, connected: true } },
      },
    });
    await page.updateComplete;
    expect(page.querySelector(".custodian__nudge")).toBeNull();
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
        channelLabels: { telegram: "Telegram" },
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
    await waitForFast(() => expect(page.querySelector(".custodian__nudge")).toBeNull());
  });

  it("does not send an event nudge while a sensitive reply is active", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
      reply: "Paste your token.",
      sensitive: true,
      action: "none",
    });
    const { context, emitGatewayEvent } = createContext(request);
    const { page } = await mountPage(context, { onboarding: false });
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());

    emitGatewayEvent({
      event: "health",
      payload: {
        channels: {
          discord: { configured: true, tokenStatus: "configured_unavailable" },
        },
      },
    });
    await page.updateComplete;
    const action = page.querySelector<HTMLButtonElement>(".custodian__nudge-action")!;
    expect(action.disabled).toBe(true);
    action.click();
    await page.updateComplete;

    expect(request).toHaveBeenCalledOnce();
    expect(page.querySelector(".custodian__nudge")).not.toBeNull();
  });

  it("does not send an event nudge while a structured question is unresolved", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
      reply: "Choose one.",
      action: "none",
      question: {
        id: "access",
        header: "Access",
        question: "How should OpenClaw work?",
        options: [{ label: "Full access" }, { label: "Ask first" }],
        isOther: false,
      },
    });
    const { context, emitGatewayEvent } = createContext(request);
    const { page } = await mountPage(context, { onboarding: false });
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());

    emitGatewayEvent({
      event: "health",
      payload: {
        channels: { discord: { configured: true, tokenStatus: "configured_unavailable" } },
      },
    });
    await page.updateComplete;
    const action = page.querySelector<HTMLButtonElement>(".custodian__nudge-action")!;
    expect(action.disabled).toBe(true);
    action.click();
    await page.updateComplete;

    expect(request).toHaveBeenCalledOnce();
    expect(page.querySelector("openclaw-option-card")).not.toBeNull();
  });

  it("does not send an event nudge while a non-card hosted wizard step awaits input", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
      reply: "Type your bot token.",
      action: "none",
      wizardInputPending: true,
    });
    const { context, emitGatewayEvent } = createContext(request);
    const { page } = await mountPage(context, { onboarding: false });
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());

    emitGatewayEvent({
      event: "health",
      payload: {
        channels: { discord: { configured: true, tokenStatus: "configured_unavailable" } },
      },
    });
    await page.updateComplete;
    const action = page.querySelector<HTMLButtonElement>(".custodian__nudge-action")!;
    expect(action.disabled).toBe(true);
    action.click();
    await page.updateComplete;

    expect(request).toHaveBeenCalledOnce();
    expect(page.querySelector("openclaw-option-card")).toBeNull();
  });

  it("keeps nudges blocked after an uncertain question reply and rejected retry", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
        reply: "Choose one.",
        action: "none",
        question: {
          id: "access",
          header: "Access",
          question: "How should OpenClaw work?",
          options: [{ label: "Full access" }, { label: "Ask first" }],
          isOther: false,
        },
      })
      .mockImplementationOnce(rejectAfterSend)
      .mockRejectedValueOnce(
        new GatewayRequestError({ code: "INVALID_REQUEST", message: "Request failed" }),
      );
    const { context, emitGatewayEvent } = createContext(request);
    const { page } = await mountPage(context, { onboarding: false });
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());

    emitGatewayEvent({
      event: "health",
      payload: {
        channels: { discord: { configured: true, tokenStatus: "configured_unavailable" } },
      },
    });
    await page.updateComplete;
    page.querySelector<HTMLButtonElement>(".option-card__skip")!.click();

    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    await waitForFast(() => expect(page.querySelector('[role="alert"]')).not.toBeNull());
    expect(page.querySelector('[role="alert"] button')).toBeNull();
    expect(page.querySelector("openclaw-option-card")).toBeNull();
    const action = page.querySelector<HTMLButtonElement>(".custodian__nudge-action")!;
    expect(action.disabled).toBe(true);
    action.click();
    await page.updateComplete;

    expect(request).toHaveBeenCalledTimes(2);

    const input = page.querySelector<HTMLTextAreaElement>(
      ".agent-chat__composer-combobox textarea",
    )!;
    input.value = "Try again";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await page.updateComplete;
    page.querySelector<HTMLButtonElement>(".chat-send-btn")!.click();

    await waitForFast(() => expect(request).toHaveBeenCalledTimes(3));
    await page.updateComplete;
    expect(page.querySelector<HTMLButtonElement>(".custodian__nudge-action")!.disabled).toBe(true);
  });

  it("restores a closed question after its reply is explicitly rejected", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
        reply: "Choose one.",
        action: "none",
        question: {
          id: "access",
          header: "Access",
          question: "How should OpenClaw work?",
          options: [{ label: "Full access" }, { label: "Ask first" }],
          isOther: false,
        },
      })
      .mockRejectedValueOnce(
        new GatewayRequestError({ code: "INVALID_REQUEST", message: "Request failed" }),
      );
    const { context, emitGatewayEvent } = createContext(request);
    const { page } = await mountPage(context, { onboarding: false });
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());

    emitGatewayEvent({
      event: "health",
      payload: {
        channels: { discord: { configured: true, tokenStatus: "configured_unavailable" } },
      },
    });
    await page.updateComplete;
    page.querySelector<HTMLButtonElement>(".option-card__skip")!.click();

    await waitForFast(() => expect(page.querySelector('[role="alert"]')).not.toBeNull());
    await page.updateComplete;
    expect(page.querySelector("openclaw-option-card")).not.toBeNull();
    expect(page.querySelector<HTMLButtonElement>(".custodian__nudge-action")!.disabled).toBe(true);
  });

  it("keeps event nudges blocked after a typed question reply has an uncertain failure", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
        reply: "Choose one.",
        action: "none",
        question: {
          id: "access",
          header: "Access",
          question: "How should OpenClaw work?",
          options: [{ label: "Full access" }, { label: "Ask first" }],
          isOther: true,
        },
      })
      .mockImplementationOnce(rejectAfterSend);
    const { context, emitGatewayEvent } = createContext(request);
    const { page } = await mountPage(context, { onboarding: false });
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());

    emitGatewayEvent({
      event: "health",
      payload: {
        channels: { discord: { configured: true, tokenStatus: "configured_unavailable" } },
      },
    });
    await page.updateComplete;
    const input = page.querySelector<HTMLTextAreaElement>(
      ".agent-chat__composer-combobox textarea",
    )!;
    input.value = "Something else";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await page.updateComplete;
    page.querySelector<HTMLButtonElement>(".chat-send-btn")!.click();

    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    await waitForFast(() => expect(page.querySelector('[role="alert"]')).not.toBeNull());
    expect(page.querySelector<HTMLButtonElement>(".option-card__skip")?.disabled).toBe(true);
    const action = page.querySelector<HTMLButtonElement>(".custodian__nudge-action")!;
    expect(action.disabled).toBe(true);
    action.click();
    await page.updateComplete;

    expect(request).toHaveBeenCalledTimes(2);
  });

  it("ignores a stale question reply outcome after a same-owner reconnect", async () => {
    let resolveQuestion!: (value: { sessionId: string; reply: string; action: "none" }) => void;
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
        reply: "Choose one.",
        action: "none",
        question: {
          id: "access",
          header: "Access",
          question: "How should OpenClaw work?",
          options: [{ label: "Full access" }, { label: "Ask first" }],
          isOther: false,
        },
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveQuestion = resolve;
          }),
      );
    const { context, emitGatewayEvent, setGatewaySnapshot } = createContext(request);
    const { page } = await mountPage(context, { onboarding: false });
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());

    emitGatewayEvent({
      event: "health",
      payload: {
        channels: { discord: { configured: true, tokenStatus: "configured_unavailable" } },
      },
    });
    await page.updateComplete;
    page.querySelector<HTMLButtonElement>(".option-card__skip")!.click();
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));

    setGatewaySnapshot({ connected: false, reconnecting: true });
    await page.updateComplete;
    setGatewaySnapshot({ connected: true, reconnecting: false });
    await page.updateComplete;
    resolveQuestion({
      sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
      reply: "Moving on.",
      action: "none",
    });

    await Promise.resolve();
    await page.updateComplete;
    const action = page.querySelector<HTMLButtonElement>(".custodian__nudge-action")!;
    expect(action.disabled).toBe(true);
    action.click();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("restores an event nudge after its request fails", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
        reply: "Everything is healthy.",
        action: "none",
      })
      .mockRejectedValueOnce(
        new GatewayRequestError({ code: "INVALID_REQUEST", message: "Request failed" }),
      );
    const { context, emitGatewayEvent } = createContext(request);
    const { page } = await mountPage(context, { onboarding: false });
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());

    emitGatewayEvent({
      event: "health",
      payload: {
        channelLabels: { telegram: "Telegram" },
        channels: {
          telegram: { configured: true, tokenStatus: "configured_unavailable" },
        },
      },
    });
    await page.updateComplete;
    page.querySelector<HTMLButtonElement>(".custodian__nudge-action")!.click();

    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    await waitForFast(() => expect(page.querySelector('[role="alert"]')).not.toBeNull());
    await page.updateComplete;
    expect(page.querySelector(".custodian__nudge")?.textContent).toContain(
      "Telegram authentication degraded",
    );
  });

  it("consumes a delivered nudge whose reply becomes stale during reconnect", async () => {
    let resolveNudge!: (value: { sessionId: string; reply: string; action: "none" }) => void;
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
        reply: "Everything is healthy.",
        action: "none",
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveNudge = resolve;
          }),
      );
    const { context, emitGatewayEvent, setGatewaySnapshot } = createContext(request);
    const { page } = await mountPage(context, { onboarding: false });
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    const degradedHealth = {
      channels: { telegram: { configured: true, healthState: "stale-socket" } },
    };

    emitGatewayEvent({ event: "health", payload: degradedHealth });
    await page.updateComplete;
    page.querySelector<HTMLButtonElement>(".custodian__nudge-action")!.click();
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));

    setGatewaySnapshot({ connected: false, reconnecting: true });
    await page.updateComplete;
    setGatewaySnapshot({ connected: true, reconnecting: false });
    await page.updateComplete;
    resolveNudge({
      sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
      reply: "Telegram checked.",
      action: "none",
    });

    await waitForFast(() => expect(page.querySelector(".custodian__nudge")).toBeNull());
    emitGatewayEvent({ event: "health", payload: degradedHealth });
    await page.updateComplete;
    expect(page.querySelector(".custodian__nudge")).toBeNull();
  });

  it("consumes a transmitted nudge when its delivery outcome is unknown", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
        reply: "Everything is healthy.",
        action: "none",
      })
      .mockImplementationOnce((_method, _params, options?: { onSent?: () => void }) => {
        options?.onSent?.();
        return Promise.reject(new Error("gateway closed"));
      });
    const { context, emitGatewayEvent } = createContext(request);
    const { page } = await mountPage(context, { onboarding: false });
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    const degradedHealth = {
      channels: { telegram: { configured: true, healthState: "stale-socket" } },
    };

    emitGatewayEvent({ event: "health", payload: degradedHealth });
    await page.updateComplete;
    page.querySelector<HTMLButtonElement>(".custodian__nudge-action")!.click();

    await waitForFast(() => expect(page.querySelector('[role="alert"]')).not.toBeNull());
    expect(page.querySelector(".custodian__nudge")).toBeNull();
    emitGatewayEvent({ event: "health", payload: degradedHealth });
    await page.updateComplete;
    expect(page.querySelector(".custodian__nudge")).toBeNull();
  });

  it("keeps a newer lower-severity failure when an earlier nudge send succeeds", async () => {
    let resolveNudge!: (value: { sessionId: string; reply: string; action: "none" }) => void;
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
        reply: "Everything is healthy.",
        action: "none",
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveNudge = resolve;
          }),
      );
    const { context, emitGatewayEvent } = createContext(request);
    const { page } = await mountPage(context, { onboarding: false });
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());

    emitGatewayEvent({
      event: "health",
      payload: {
        channelLabels: { telegram: "Telegram" },
        channels: {
          telegram: { configured: true, tokenStatus: "configured_unavailable" },
        },
      },
    });
    await page.updateComplete;
    page.querySelector<HTMLButtonElement>(".custodian__nudge-action")!.click();
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));

    emitGatewayEvent({
      event: "health",
      payload: {
        channelLabels: { discord: "Discord" },
        channels: { discord: { configured: true, healthState: "stale-socket" } },
      },
    });
    resolveNudge({
      sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
      reply: "Telegram checked.",
      action: "none",
    });

    await waitForFast(() => expect(page.textContent).toContain("Telegram checked."));
    await page.updateComplete;
    expect(page.querySelector(".custodian__nudge")?.textContent).toContain("Discord is degraded");
  });

  it("consumes an in-flight incident that becomes current again before completion", async () => {
    let resolveNudge!: (value: { sessionId: string; reply: string; action: "none" }) => void;
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
        reply: "Everything is healthy.",
        action: "none",
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveNudge = resolve;
          }),
      );
    const { context, emitGatewayEvent } = createContext(request);
    const { page } = await mountPage(context, { onboarding: false });
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    const telegramFailure = {
      channelLabels: { telegram: "Telegram" },
      channels: { telegram: { configured: true, running: true, connected: false } },
    };

    emitGatewayEvent({ event: "health", payload: telegramFailure });
    await page.updateComplete;
    page.querySelector<HTMLButtonElement>(".custodian__nudge-action")!.click();
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));

    emitGatewayEvent({
      event: "health",
      payload: {
        channels: { discord: { configured: true, tokenStatus: "configured_unavailable" } },
      },
    });
    emitGatewayEvent({ event: "health", payload: telegramFailure });
    resolveNudge({
      sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
      reply: "Telegram checked.",
      action: "none",
    });

    await waitForFast(() => expect(page.querySelector(".custodian__nudge")).toBeNull());
    emitGatewayEvent({ event: "health", payload: telegramFailure });
    await page.updateComplete;
    expect(page.querySelector(".custodian__nudge")).toBeNull();
  });

  it("consumes a nudge after an unchanged health snapshot arrives while sending", async () => {
    let resolveNudge!: (value: { sessionId: string; reply: string; action: "none" }) => void;
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
        reply: "Everything is healthy.",
        action: "none",
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveNudge = resolve;
          }),
      );
    const { context, emitGatewayEvent } = createContext(request);
    const { page } = await mountPage(context, { onboarding: false });
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    const degradedHealth = {
      channels: { telegram: { configured: true, healthState: "stale-socket" } },
    };

    emitGatewayEvent({ event: "health", payload: degradedHealth });
    await page.updateComplete;
    page.querySelector<HTMLButtonElement>(".custodian__nudge-action")!.click();
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));

    emitGatewayEvent({ event: "health", payload: degradedHealth });
    resolveNudge({
      sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
      reply: "Telegram checked.",
      action: "none",
    });

    await waitForFast(() => expect(page.querySelector(".custodian__nudge")).toBeNull());
  });

  it("does not restore a failed nudge after health recovers while sending", async () => {
    let rejectNudge!: (error: Error) => void;
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
        reply: "Everything is healthy.",
        action: "none",
      })
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectNudge = reject;
          }),
      );
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
    page.querySelector<HTMLButtonElement>(".custodian__nudge-action")!.click();
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));

    emitGatewayEvent({
      event: "health",
      payload: {
        channels: { telegram: { configured: true, running: true, connected: true } },
      },
    });
    rejectNudge(new Error("Request failed"));

    await waitForFast(() => expect(page.querySelector('[role="alert"]')).not.toBeNull());
    await page.updateComplete;
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
});
