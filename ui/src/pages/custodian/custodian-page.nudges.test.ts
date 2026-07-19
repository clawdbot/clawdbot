/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createContext, mountPage } from "./custodian-page.test-harness.ts";

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
});
