import { beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

describe("resolveGatewayScopedTools", () => {
  beforeAll(() => {
    resolveGatewayScopedTools({
      cfg: { tools: { profile: "minimal" } } as OpenClawConfig,
      sessionKey: "agent:main:telegram:group:-100123",
      messageProvider: "telegram",
      inboundEventKind: "room_event",
      surface: "loopback",
    });
  });

  it("force-allows the message tool for room-event loopback turns", () => {
    const result = resolveGatewayScopedTools({
      cfg: { tools: { profile: "minimal" } } as OpenClawConfig,
      sessionKey: "agent:main:telegram:group:-100123",
      messageProvider: "telegram",
      inboundEventKind: "room_event",
      surface: "loopback",
    });

    const messageTool = result.tools.find((tool) => tool.name === "message");
    expect(messageTool?.description).toContain(
      "visible replies to the current source conversation",
    );
  });

  it("keeps ordinary loopback turns under the configured profile", () => {
    const result = resolveGatewayScopedTools({
      cfg: { tools: { profile: "minimal" } } as OpenClawConfig,
      sessionKey: "agent:main:telegram:group:-100123",
      messageProvider: "telegram",
      inboundEventKind: "user_request",
      surface: "loopback",
    });

    expect(result.tools.some((tool) => tool.name === "message")).toBe(false);
  });
});
