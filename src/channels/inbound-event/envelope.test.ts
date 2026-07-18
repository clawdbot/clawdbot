import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createChannelInboundEnvelopeBuilder,
  resolveChannelInboundRouteEnvelope,
} from "./envelope.js";

const readSessionUpdatedAt = vi.hoisted(() => vi.fn(() => 60_000));
const resolveStorePath = vi.hoisted(() => vi.fn(() => "/state/main/sessions.json"));
const resolveAgentRoute = vi.hoisted(() =>
  vi.fn(() => ({
    agentId: "main",
    sessionKey: "agent:main:telegram:direct:peer",
    accountId: "default",
  })),
);

vi.mock("../../config/sessions/paths.js", () => ({ resolveStorePath }));
vi.mock("../../config/sessions/session-accessor.js", () => ({ readSessionUpdatedAt }));
vi.mock("../../routing/resolve-route.js", () => ({ resolveAgentRoute }));

const cfg = {
  agents: { defaults: { envelopeTimestamp: "off" } },
  session: { store: "/state/{agentId}/sessions.json" },
} as OpenClawConfig;

describe("channel inbound envelope", () => {
  beforeEach(() => vi.clearAllMocks());

  it("owns session lookup and formatting for a resolved route", () => {
    const buildEnvelope = createChannelInboundEnvelopeBuilder({
      cfg,
      route: { agentId: "main", sessionKey: "agent:main:telegram:direct:peer" },
    });

    expect(
      buildEnvelope({
        channel: "Telegram",
        from: "Alice",
        body: "hello",
        timestamp: 120_000,
      }),
    ).toBe("[Telegram Alice +1m] hello");
    expect(resolveStorePath).toHaveBeenCalledWith(cfg.session?.store, { agentId: "main" });
    expect(readSessionUpdatedAt).toHaveBeenCalledWith({
      storePath: "/state/main/sessions.json",
      sessionKey: "agent:main:telegram:direct:peer",
    });
  });

  it("binds routing and envelope construction in one core operation", () => {
    const params = {
      cfg,
      channel: "telegram",
      accountId: "default",
      peer: { kind: "direct" as const, id: "peer" },
    };
    const resolved = resolveChannelInboundRouteEnvelope(params);

    expect(resolveAgentRoute).toHaveBeenCalledWith(params);
    expect(resolved.route.sessionKey).toBe("agent:main:telegram:direct:peer");
    expect(resolved.buildEnvelope({ channel: "Telegram", from: "Alice", body: "hello" })).toBe(
      "[Telegram Alice] hello",
    );
  });

  it("formats buffered history without reading the live session timestamp", () => {
    const buildEnvelope = createChannelInboundEnvelopeBuilder({
      cfg,
      route: { agentId: "main", sessionKey: "agent:main:telegram:direct:peer" },
    });

    expect(
      buildEnvelope({
        channel: "Telegram",
        from: "Alice",
        body: "older",
        timestamp: 30_000,
        previousTimestamp: null,
      }),
    ).toBe("[Telegram Alice] older");
    expect(readSessionUpdatedAt).not.toHaveBeenCalled();
  });
});
