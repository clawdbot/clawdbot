/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../../api/gateway.ts";
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

  it("blocks messages until inference setup succeeds", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(
        new GatewayRequestError({
          code: "UNAVAILABLE",
          message: "OpenClaw requires working inference: no configured model",
          details: { code: "system_agent_inference_unavailable" },
        }),
      )
      .mockResolvedValueOnce({
        sessionId: "shared-session",
        reply: "Ready.",
        action: "none",
      });
    const { context } = createContext(request);
    const store = new CustodianSessionStore();

    store.connect(context, "caretaker");
    await waitForFast(() => expect(store.setupRequired).toBe(true));
    expect(store.setupIssue).toBe("unavailable");

    await expect(store.send("should not send")).resolves.toBe("rejected");
    expect(request).toHaveBeenCalledOnce();

    store.retry();
    await waitForFast(() => expect(store.setupRequired).toBe(false));
    await waitForFast(() => expect(store.messages.at(-1)?.text).toBe("Ready."));
  });

  it("shows setup before starting chat when the default agent has no model", async () => {
    const request = vi.fn();
    const { context } = createContext(request, ["openclaw.chat"], {
      agentsList: {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [{ id: "main" }],
      },
    });
    const store = new CustodianSessionStore();

    store.connect(context, "caretaker");

    expect(store.setupRequired).toBe(true);
    expect(store.setupIssue).toBe("missing");
    expect(store.sending).toBe(false);
    expect(request).not.toHaveBeenCalled();
    await expect(store.send("should not send")).resolves.toBe("rejected");
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
