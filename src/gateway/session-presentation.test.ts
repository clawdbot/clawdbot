import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import { buildGatewaySessionPresentation } from "./session-presentation.js";

function entry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return { sessionId: "session", updatedAt: 1, ...overrides };
}

describe("buildGatewaySessionPresentation", () => {
  it.each([
    ["agent:main:main", true, "main", "Main session", false],
    [
      "agent:main:dashboard:01234567-89ab-cdef-0123-456789abcdef",
      false,
      "dashboard",
      "New session",
      false,
    ],
    [
      "agent:main:tui-01234567-89ab-cdef-0123-456789abcdef",
      false,
      "tui",
      "Terminal session",
      false,
    ],
    ["agent:main:subagent:child", false, "subagent", "Subagent", true],
    ["agent:main:acp:child", false, "acp", "ACP session", true],
    ["agent:main:cron:job", false, "cron", "Scheduled task", true],
    ["agent:main:hook:run", false, "hook", "Hook run", true],
    ["agent:main:harness:codex:supervision:thread", false, "harness", "Harness session", true],
    ["agent:main:voice:call:123", false, "voice", "Voice call", false],
    ["agent:main:dreaming-narrative-rem-workspace", false, "dreaming", "Dreaming", true],
    ["agent:main:commitments:run", false, "system", "Background task", true],
  ] as const)("classifies %s", (key, isMain, family, title, isBackground) => {
    expect(buildGatewaySessionPresentation({ key, isMain, entry: entry() })).toMatchObject({
      family,
      title,
      titleSource: "generated",
      isBackground,
      isMain,
    });
  });

  it("projects channel and account context without exposing the peer id", () => {
    const presentation = buildGatewaySessionPresentation({
      key: "agent:main:telegram:main:direct:491234567890",
      isMain: false,
      entry: entry(),
    });

    expect(presentation).toMatchObject({
      title: "Telegram direct message",
      titleSource: "generated",
      family: "direct",
      agentId: "main",
      channel: "telegram",
      accountId: "main",
      peerKind: "direct",
      subtitle: "Telegram · account main · agent main",
    });
    expect(JSON.stringify(presentation)).not.toContain("491234567890");
  });

  it("projects group and thread families with an opaque base key", () => {
    expect(
      buildGatewaySessionPresentation({
        key: "agent:ops:discord:group:dev",
        isMain: false,
        entry: entry({ displayName: "Developer chat" }),
        displayName: "Developer chat",
      }),
    ).toMatchObject({ family: "group", title: "Developer chat", channel: "discord" });

    expect(
      buildGatewaySessionPresentation({
        key: "agent:ops:explicit:work:thread:launch",
        isMain: false,
        entry: entry(),
      }),
    ).toMatchObject({ family: "thread" });

    const routedThread = buildGatewaySessionPresentation({
      key: "agent:ops:telegram:main:direct:491234567890:thread:launch",
      isMain: false,
      entry: entry(),
    });
    expect(JSON.stringify(routedThread)).not.toContain("491234567890");

    const legacyDirectThread = buildGatewaySessionPresentation({
      key: "agent:ops:direct:491234567890:thread:launch",
      isMain: false,
      entry: entry(),
    });
    expect(JSON.stringify(legacyDirectThread)).not.toContain("491234567890");
  });

  it("uses stored group metadata when a provider key is not a delivery route", () => {
    expect(
      buildGatewaySessionPresentation({
        key: "provider-owned-room-key",
        isMain: false,
        entry: entry({ chatType: "group", channel: "custom-channel" }),
      }),
    ).toMatchObject({ family: "group", channel: "custom-channel" });

    expect(
      buildGatewaySessionPresentation({
        key: "provider-owned-direct-key",
        isMain: false,
        entry: entry({ chatType: "direct", channel: "custom-channel" }),
      }),
    ).toMatchObject({ family: "direct", title: "Custom-channel direct message" });
  });

  it("uses the persisted heartbeat marker instead of guessing from a suffix", () => {
    expect(
      buildGatewaySessionPresentation({
        key: "agent:main:alerts:heartbeat",
        isMain: false,
        entry: entry(),
      }).family,
    ).toBe("custom");

    expect(
      buildGatewaySessionPresentation({
        key: "agent:main:alerts:heartbeat",
        isMain: false,
        entry: entry({ heartbeatIsolatedBaseSessionKey: "agent:main:alerts" }),
      }),
    ).toMatchObject({
      family: "heartbeat",
      isBackground: true,
    });
  });

  it("uses labels and readable explicit ids without echoing full machine ids", () => {
    expect(
      buildGatewaySessionPresentation({
        key: "agent:main:subagent:child",
        isMain: false,
        entry: entry({ label: "Research" }),
        displayName: "Research",
      }).title,
    ).toBe("Research");
    expect(
      buildGatewaySessionPresentation({
        key: "agent:main:subagent:child",
        isMain: false,
        entry: entry({ label: "Research" }),
        displayName: "Research",
      }).titleSource,
    ).toBe("label");
    expect(
      buildGatewaySessionPresentation({
        key: "agent:main:explicit:model-run-01234567-89ab-cdef-0123-456789abcdef",
        isMain: false,
        entry: entry(),
      }).title,
    ).toBe("model-run-…cdef");
  });
});
