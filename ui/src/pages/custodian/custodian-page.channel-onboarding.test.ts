/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ChannelsStatusSnapshot } from "../../api/types.ts";
import { channelSnapshotEntryIsActive, createChannelCapability } from "../../lib/channels/index.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createContext, mountPage } from "./custodian-page.test-harness.ts";

function channelSnapshot(patch: Partial<ChannelsStatusSnapshot> = {}): ChannelsStatusSnapshot {
  return {
    ts: 1_700_000_000_000,
    channelOrder: ["telegram"],
    channelLabels: { telegram: "Telegram" },
    channels: { telegram: { configured: false, running: false, connected: false } },
    channelAccounts: { telegram: [] },
    channelDefaultAccountId: {},
    ...patch,
  };
}

describe("custodian channel onboarding", () => {
  beforeEach(() => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("shows optional channel setup after first-run model setup and consumes dismissal", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
      reply: "Your AI is ready.",
      action: "none",
    });
    const { context } = createContext(request, ["openclaw.chat"], {
      channelsSnapshot: channelSnapshot(),
    });
    const { page } = await mountPage(context, { onboarding: true });
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());

    const nudge = page.querySelector(".custodian__nudge--channel-onboarding");
    expect(nudge?.textContent).toContain("Reach OpenClaw outside this app");
    expect(nudge?.textContent).toContain("The web app already works");

    page.querySelector<HTMLButtonElement>('button[aria-label="Keep using the web app"]')?.click();
    await page.updateComplete;

    expect(context.replace).toHaveBeenCalledWith("custodian");
    expect(page.querySelector(".custodian__nudge--channel-onboarding")).toBeNull();
  });

  it("opens Channels from the optional first-run nudge", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
      reply: "Your AI is ready.",
      action: "none",
    });
    const { context } = createContext(request, ["openclaw.chat"], {
      channelsSnapshot: channelSnapshot(),
    });
    const { page } = await mountPage(context, { onboarding: true });
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());

    page.querySelector<HTMLButtonElement>(".custodian__nudge-cta")?.click();
    await page.updateComplete;

    expect(context.navigate).toHaveBeenCalledWith("channels");
    expect(context.replace).not.toHaveBeenCalled();
    expect(page.querySelector(".custodian__nudge--channel-onboarding")).toBeNull();
  });

  it("loads channel status once when onboarding has no snapshot", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
      reply: "Your AI is ready.",
      action: "none",
    });
    const { context } = createContext(request);
    await mountPage(context, { onboarding: true });

    await waitForFast(() => expect(context.channels.refresh).toHaveBeenCalledWith(false));
    expect(context.channels.refresh).toHaveBeenCalledOnce();
  });

  it("retries channel status after a disconnect invalidates the first refresh", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
      reply: "Your AI is ready.",
      action: "none",
    });
    const { context, setChannelsConnected } = createContext(request);
    await mountPage(context, { onboarding: true });
    await waitForFast(() => expect(context.channels.refresh).toHaveBeenCalledOnce());

    setChannelsConnected(false);
    setChannelsConnected(true);

    expect(context.channels.refresh).toHaveBeenCalledTimes(2);
    expect(context.channels.refresh).toHaveBeenNthCalledWith(2, false);
  });

  it("awaits fresh channel status after reconnecting with a stale successful snapshot and error", async () => {
    const freshStatus = createDeferred<ChannelsStatusSnapshot>();
    let statusRequestCount = 0;
    const request = vi.fn((method: string) => {
      if (method === "channels.status") {
        statusRequestCount += 1;
        if (statusRequestCount === 1) {
          return Promise.resolve(channelSnapshot());
        }
        if (statusRequestCount === 2) {
          return Promise.reject(new Error("status unavailable"));
        }
        return freshStatus.promise;
      }
      return Promise.resolve({
        sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
        reply: "Ready.",
        action: "none",
      });
    });
    const { context, setGatewaySnapshot } = createContext(request);
    const channels = createChannelCapability(context.gateway);
    Object.assign(context, { channels });
    await channels.refresh();
    await channels.refresh();
    expect(channels.state.channelsSnapshot).not.toBeNull();
    expect(channels.state.channelsError).toBe("status unavailable");
    const { page } = await mountPage(context, { onboarding: true });

    setGatewaySnapshot({ phase: "reconnecting" });
    setGatewaySnapshot({ phase: "connected" });

    await waitForFast(() => expect(statusRequestCount).toBe(3));
    expect(channels.state.channelsSnapshot).toBeNull();
    expect(channels.state.channelsLoading).toBe(true);
    expect(page.querySelector(".custodian__nudge--channel-onboarding")).toBeNull();

    freshStatus.resolve(
      channelSnapshot({
        channels: { telegram: { configured: true, running: true, connected: true } },
      }),
    );
    await waitForFast(() => expect(channels.state.channelsLoading).toBe(false));
    expect(channelSnapshotEntryIsActive(channels.state.channelsSnapshot, "telegram")).toBe(true);
    expect(page.querySelector(".custodian__nudge--channel-onboarding")).toBeNull();
    channels.dispose();
  });

  it("shows an error instead of a healthy nudge when refresh fails with a stale snapshot", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
      reply: "Ready.",
      action: "none",
    });
    const { context, setChannelsError } = createContext(request, ["openclaw.chat"], {
      channelsSnapshot: channelSnapshot(),
    });
    const { page } = await mountPage(context, { onboarding: true });

    setChannelsError("status unavailable");
    await page.updateComplete;

    expect(page.querySelector('[role="alert"]')?.textContent).toContain(
      "Channel status is unavailable",
    );
    expect(page.textContent).not.toContain("The web app already works");
  });

  it("keeps retry feedback visible until a deferred channel refresh succeeds", async () => {
    const retryStatus = createDeferred<ChannelsStatusSnapshot>();
    let statusRequestCount = 0;
    const request = vi.fn((method: string) => {
      if (method === "channels.status") {
        statusRequestCount += 1;
        return statusRequestCount === 1
          ? Promise.reject(new Error("status unavailable"))
          : retryStatus.promise;
      }
      return Promise.resolve({
        sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
        reply: "Ready.",
        action: "none",
      });
    });
    const { context } = createContext(request);
    const channels = createChannelCapability(context.gateway);
    Object.assign(context, { channels });
    await channels.refresh();
    const { page } = await mountPage(context, { onboarding: true });

    const retry = page.querySelector<HTMLButtonElement>(".custodian__nudge-cta");
    expect(retry?.textContent).toContain("Retry");
    retry?.click();

    await waitForFast(() => expect(statusRequestCount).toBe(2));
    await page.updateComplete;
    expect(channels.state.channelsLoading).toBe(true);
    expect(channels.state.channelsError).toBe("status unavailable");
    expect(page.querySelector('[role="alert"]')).not.toBeNull();
    expect(page.querySelector<HTMLButtonElement>(".custodian__nudge-cta")?.disabled).toBe(true);
    expect(page.querySelector(".custodian__nudge-cta")?.textContent).toContain("Loading");

    retryStatus.resolve(
      channelSnapshot({
        channels: { telegram: { configured: true, running: true, connected: true } },
      }),
    );
    await waitForFast(() => expect(channels.state.channelsLoading).toBe(false));
    expect(channels.state.channelsError).toBeNull();
    expect(page.querySelector(".custodian__nudge--channel-onboarding")).toBeNull();
    channels.dispose();
  });

  it("does not refresh after the channel prompt is dismissed", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
      reply: "Ready.",
      action: "none",
    });
    const { context, setChannelsConnected } = createContext(request);
    const { page } = await mountPage(context, { onboarding: true });
    await waitForFast(() => expect(context.channels.refresh).toHaveBeenCalledOnce());

    page.store.dismissChannelOnboardingNudge();
    setChannelsConnected(false);
    setChannelsConnected(true);

    expect(context.channels.refresh).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "normal caretaker visits",
      onboarding: false,
      snapshot: channelSnapshot(),
    },
    {
      name: "partial channel snapshots",
      onboarding: true,
      snapshot: channelSnapshot({ partial: true }),
    },
    {
      name: "configured aggregate channels",
      onboarding: true,
      snapshot: channelSnapshot({
        channels: { telegram: { configured: true, running: false, connected: false } },
      }),
    },
    {
      name: "connected channel accounts",
      onboarding: true,
      snapshot: channelSnapshot({
        channelAccounts: {
          telegram: [{ accountId: "work", configured: false, connected: true }],
        },
      }),
    },
  ])("does not show optional channel setup for $name", async ({ onboarding, snapshot }) => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
      reply: "Ready.",
      action: "none",
    });
    const { context } = createContext(request, ["openclaw.chat"], {
      channelsSnapshot: snapshot,
    });
    const { page } = await mountPage(context, { onboarding });
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());

    expect(page.querySelector(".custodian__nudge--channel-onboarding")).toBeNull();
  });

  it("removes channel setup as soon as a channel becomes active", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
      reply: "Ready.",
      action: "none",
    });
    const { context, setChannelsSnapshot } = createContext(request, ["openclaw.chat"], {
      channelsSnapshot: channelSnapshot(),
    });
    const { page } = await mountPage(context, { onboarding: true });
    await waitForFast(() =>
      expect(page.querySelector(".custodian__nudge--channel-onboarding")).not.toBeNull(),
    );

    setChannelsSnapshot(
      channelSnapshot({
        channelAccounts: {
          telegram: [{ accountId: "default", configured: true, connected: true }],
        },
      }),
    );
    await page.updateComplete;

    expect(page.querySelector(".custodian__nudge--channel-onboarding")).toBeNull();
  });
});
