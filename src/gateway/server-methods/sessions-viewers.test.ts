import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { SESSION_VIEWER_PRESENCE_MAX_KEYS } from "../../../packages/gateway-protocol/src/schema/sessions-viewer-presence.js";

const sessionsListHandler = vi.hoisted(() =>
  vi.fn(async ({ respond }: GatewayRequestHandlerOptions) => {
    respond(true, { count: 1 }, undefined);
  }),
);

vi.mock("./sessions-read.js", () => ({ sessionsListHandler }));

import { sessionSubscriptionHandlers } from "./sessions-subscriptions.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions } from "./types.js";

async function declare(params: {
  body: Record<string, unknown>;
  connId?: string;
  context: GatewayRequestContext;
}) {
  const respond = vi.fn();
  await expectDefined(
    sessionSubscriptionHandlers["sessions.viewers.set"],
    'sessionSubscriptionHandlers["sessions.viewers.set"] test invariant',
  )({
    req: { id: "req-viewers", method: "sessions.viewers.set" } as never,
    params: params.body,
    respond,
    context: params.context,
    client: params.connId === undefined ? null : ({ connId: params.connId } as never),
    isWebchatConnect: () => false,
  } satisfies GatewayRequestHandlerOptions);
  return respond;
}

function createContext() {
  const replace = vi.fn((_connId: string, sessionKeys: readonly string[]) =>
    [...new Set(sessionKeys)].toSorted(),
  );
  const context = {
    getRuntimeConfig: () => ({
      agents: { list: [{ id: "work", default: true }] },
      session: { mainKey: "home" },
    }),
    sessionViewerPresence: { replace },
  } as unknown as GatewayRequestContext;
  return { context, replace };
}

describe("sessions.viewers.set", () => {
  it("canonicalizes and atomically replaces the connection set", async () => {
    const { context, replace } = createContext();
    const respond = await declare({
      body: { sessionKeys: [" main ", "agent:work:other", "main"] },
      connId: " conn-viewer ",
      context,
    });

    expect(replace).toHaveBeenCalledWith("conn-viewer", [
      "agent:work:home",
      "agent:work:other",
      "agent:work:home",
    ]);
    expect(respond).toHaveBeenCalledWith(
      true,
      { sessionKeys: ["agent:work:home", "agent:work:other"] },
      undefined,
    );
  });

  it("accepts an empty declaration and rejects malformed or oversized sets", async () => {
    const { context, replace } = createContext();
    const empty = await declare({ body: { sessionKeys: [] }, connId: "conn-viewer", context });
    expect(empty).toHaveBeenCalledWith(true, { sessionKeys: [] }, undefined);

    const whitespace = await declare({
      body: { sessionKeys: [" "] },
      connId: "conn-viewer",
      context,
    });
    expect(whitespace).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );

    const oversized = await declare({
      body: {
        sessionKeys: Array.from(
          { length: SESSION_VIEWER_PRESENCE_MAX_KEYS + 1 },
          (_, index) => `session-${index}`,
        ),
      },
      connId: "conn-viewer",
      context,
    });
    expect(oversized).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it("requires a live connection and declaration owner", async () => {
    const context = { getRuntimeConfig: () => ({}) } as unknown as GatewayRequestContext;
    const respond = await declare({ body: { sessionKeys: [] }, context });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE" }),
    );
  });

  it("scopes bare viewer identities by explicit owner and rejects ambiguity", async () => {
    const replace = vi.fn((_connId: string, sessionKeys: readonly string[]) => sessionKeys);
    const context = {
      getRuntimeConfig: () => ({
        agents: { ownership: "explicit", list: [{ id: "main" }, { id: "work" }] },
      }),
      sessionViewerPresence: { replace },
    } as unknown as GatewayRequestContext;

    const selected = await declare({
      body: { sessionKeys: ["global"], agentId: "work" },
      connId: "conn-viewer",
      context,
    });
    expect(replace).toHaveBeenCalledWith("conn-viewer", ["agent:work:global"]);
    expect(selected).toHaveBeenCalledWith(true, { sessionKeys: ["agent:work:global"] }, undefined);

    replace.mockClear();
    const ambiguous = await declare({
      body: { sessionKeys: ["global"] },
      connId: "conn-viewer",
      context,
    });
    expect(replace).not.toHaveBeenCalled();
    expect(ambiguous).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });
});

describe("sessions.subscribe", () => {
  it("registers events before projecting an atomic bootstrap roster", async () => {
    const subscribeSessionEvents = vi.fn();
    const context = { subscribeSessionEvents } as unknown as GatewayRequestContext;
    const respond = vi.fn();
    sessionsListHandler.mockClear();

    await expectDefined(
      sessionSubscriptionHandlers["sessions.subscribe"],
      'sessionSubscriptionHandlers["sessions.subscribe"] test invariant',
    )({
      req: { id: "req-subscribe", method: "sessions.subscribe" } as never,
      params: { limit: 1, ownerFirst: true },
      respond,
      context,
      client: { connId: "control-ui-1" } as never,
      isWebchatConnect: () => false,
    } satisfies GatewayRequestHandlerOptions);

    expect(subscribeSessionEvents).toHaveBeenCalledWith("control-ui-1");
    expect(subscribeSessionEvents.mock.invocationCallOrder[0]).toBeLessThan(
      sessionsListHandler.mock.invocationCallOrder[0]!,
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      { subscribed: true, list: { count: 1 } },
      undefined,
      undefined,
    );
  });
});
