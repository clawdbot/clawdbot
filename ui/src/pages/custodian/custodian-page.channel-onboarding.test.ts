/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelsStatusSnapshot } from "../../api/types.ts";
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
