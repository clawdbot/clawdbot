/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createContext } from "./custodian-page.test-harness.ts";
import { CustodianSessionStore } from "./custodian-session-store.ts";

describe("CustodianSessionStore", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shares one live session across repeated surface connections", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "shared-session",
        reply: "Ready.",
        action: "none",
      })
      .mockResolvedValueOnce({
        sessionId: "shared-session",
        reply: "Still here.",
        action: "none",
      });
    const { context } = createContext(request);
    const store = new CustodianSessionStore();
    const firstSurfaceUpdates = vi.fn();
    const panelSurfaceUpdates = vi.fn();
    store.subscribe(firstSurfaceUpdates);
    store.subscribe(panelSurfaceUpdates);

    store.connect(context, "caretaker");
    store.connect(context, "caretaker");
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());

    await store.send("Check this system");

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      sessionId: "shared-session",
      message: "Check this system",
    });
    expect(store.messages.map((message) => message.text)).toEqual([
      "Ready.",
      "Check this system",
      "Still here.",
    ]);
    expect(store.hasRealUserTurn()).toBe(true);
    expect(firstSurfaceUpdates).toHaveBeenCalled();
    expect(panelSurfaceUpdates).toHaveBeenCalled();
  });

  it("accepts new event nudges after a conversation variant rotates", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "shared-session",
      reply: "Ready.",
      action: "none",
    });
    const { context, emitGatewayEvent } = createContext(request);
    const store = new CustodianSessionStore();
    store.connect(context, "caretaker");
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());

    emitGatewayEvent({
      event: "health",
      payload: { configReload: { hotReloadStatus: "disabled" }, channels: {} },
    });
    expect(store.eventNudge).not.toBeNull();
    store.dismissEventNudge();
    expect(store.eventNudge).toBeNull();

    store.connect(context, "onboarding");
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    store.connect(context, "caretaker");
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(3));
    emitGatewayEvent({
      event: "health",
      payload: { configReload: { hotReloadStatus: "disabled" }, channels: {} },
    });

    expect(store.eventNudge).not.toBeNull();
  });
});
