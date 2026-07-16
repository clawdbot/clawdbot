/** Targeted system-event routing and wake behavior. */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { peekSystemEvents, resetSystemEventsForTest } from "../../infra/system-events.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  requestHeartbeat: vi.fn(),
  loadGatewaySessionRow: vi.fn(),
}));

vi.mock("../../infra/heartbeat-wake.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/heartbeat-wake.js")>()),
  requestHeartbeat: mocks.requestHeartbeat,
}));

vi.mock("../session-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session-utils.js")>()),
  loadGatewaySessionRow: mocks.loadGatewaySessionRow,
}));

import { systemHandlers } from "./system.js";

describe("system-event routing", () => {
  beforeEach(() => {
    resetSystemEventsForTest();
  });

  afterEach(() => {
    resetSystemEventsForTest();
    mocks.requestHeartbeat.mockReset();
    mocks.loadGatewaySessionRow.mockReset();
  });

  it("queues and immediately wakes the requested session", async () => {
    const respond = vi.fn();
    const sessionKey = "agent:main:main";
    mocks.loadGatewaySessionRow.mockReturnValue({ key: sessionKey, archived: false });
    const request = {
      params: {
        text: "OpenClaw updated. Welcome the user back.",
        sessionKey,
        wake: true,
      },
      respond,
      context: {
        broadcast: vi.fn(),
        incrementPresenceVersion: vi.fn(() => 1),
        getHealthVersion: vi.fn(() => 1),
        getRuntimeConfig: vi.fn(() => ({ agents: { list: [{ id: "main" }] } })),
      },
    } as unknown as GatewayRequestHandlerOptions;

    await expectDefined(
      systemHandlers["system-event"],
      'systemHandlers["system-event"] test invariant',
    )(request);

    expect(peekSystemEvents(sessionKey)).toEqual(["OpenClaw updated. Welcome the user back."]);
    expect(mocks.requestHeartbeat).toHaveBeenCalledWith({
      source: "notifications-event",
      intent: "immediate",
      reason: "wake",
      sessionKey,
      heartbeat: { target: "last" },
    });
    expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
  });

  it("rejects immediate wakes for unconfigured agents", async () => {
    const respond = vi.fn();
    const request = {
      params: {
        text: "OpenClaw updated. Welcome the user back.",
        sessionKey: "agent:bogus:main",
        wake: true,
      },
      respond,
      context: {
        broadcast: vi.fn(),
        incrementPresenceVersion: vi.fn(() => 1),
        getHealthVersion: vi.fn(() => 1),
        getRuntimeConfig: vi.fn(() => ({ agents: { list: [{ id: "main" }] } })),
      },
    } as unknown as GatewayRequestHandlerOptions;

    await expectDefined(
      systemHandlers["system-event"],
      'systemHandlers["system-event"] test invariant',
    )(request);

    expect(peekSystemEvents("agent:bogus:main")).toEqual([]);
    expect(mocks.requestHeartbeat).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: 'Unknown agent id "bogus"' }),
    );
  });

  it("rejects immediate wakes for missing sessions", async () => {
    const respond = vi.fn();
    const sessionKey = "agent:main:missing";
    mocks.loadGatewaySessionRow.mockReturnValue(null);
    const request = {
      params: {
        text: "OpenClaw updated. Welcome the user back.",
        sessionKey,
        wake: true,
      },
      respond,
      context: {
        broadcast: vi.fn(),
        incrementPresenceVersion: vi.fn(() => 1),
        getHealthVersion: vi.fn(() => 1),
        getRuntimeConfig: vi.fn(() => ({ agents: { list: [{ id: "main" }] } })),
      },
    } as unknown as GatewayRequestHandlerOptions;

    await expectDefined(
      systemHandlers["system-event"],
      'systemHandlers["system-event"] test invariant',
    )(request);

    expect(peekSystemEvents(sessionKey)).toEqual([]);
    expect(mocks.requestHeartbeat).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: `Unknown or archived session "${sessionKey}"` }),
    );
  });

  it("rejects wake requests mixed with node presence events", async () => {
    const respond = vi.fn();
    const sessionKey = "agent:main:main";
    const request = {
      params: {
        text: "Node: Operator Mac",
        deviceId: "device-1",
        sessionKey,
        wake: true,
      },
      respond,
      context: {
        broadcast: vi.fn(),
        incrementPresenceVersion: vi.fn(() => 1),
        getHealthVersion: vi.fn(() => 1),
        getRuntimeConfig: vi.fn(() => ({ agents: { list: [{ id: "main" }] } })),
      },
    } as unknown as GatewayRequestHandlerOptions;

    await expectDefined(
      systemHandlers["system-event"],
      'systemHandlers["system-event"] test invariant',
    )(request);

    expect(peekSystemEvents(sessionKey)).toEqual([]);
    expect(mocks.loadGatewaySessionRow).not.toHaveBeenCalled();
    expect(mocks.requestHeartbeat).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "wake is not supported for node presence events" }),
    );
  });
});
