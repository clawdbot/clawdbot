import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { sessionPresentationForRow } from "./session-presentation.js";

function entry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return { sessionId: "session", updatedAt: 1, ...overrides };
}

function presentation(params: {
  key: string;
  isMain: boolean;
  agentId?: string;
  channel?: string;
  displayName?: string;
  entry?: SessionEntry;
}) {
  const cfg = {
    agents: { list: [{ id: "main", default: true }] },
    ...(params.isMain ? {} : { session: { mainKey: "not-main" } }),
  } as OpenClawConfig;
  return sessionPresentationForRow(
    cfg,
    params.key,
    params.agentId ?? "main",
    params.displayName,
    params.entry,
    params.channel,
  );
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
    expect(presentation({ key, isMain, entry: entry() })).toMatchObject({
      family,
      title,
      titleSource: "generated",
      isBackground,
      isMain,
    });
  });

  it("projects channel and account context without exposing the peer id", () => {
    const result = presentation({
      key: "agent:main:telegram:main:direct:491234567890",
      isMain: false,
      entry: entry(),
    });

    expect(result).toMatchObject({
      title: "Telegram direct message",
      titleSource: "generated",
      family: "direct",
      agentId: "main",
      channel: "telegram",
      accountId: "main",
      peerKind: "direct",
      subtitle: "Telegram · account main · agent main",
    });
    expect(JSON.stringify(result)).not.toContain("491234567890");
  });

  it.each(["U123ABC45", "person@example.com"])(
    "does not use a transport-derived direct display name: %s",
    (peerId) => {
      const result = presentation({
        key: `agent:main:slack:main:direct:${peerId}`,
        isMain: false,
        channel: "slack",
        entry: entry({ chatType: "direct", displayName: peerId }),
        displayName: peerId,
      });

      expect(result).toMatchObject({
        title: "Slack direct message",
        titleSource: "generated",
        family: "direct",
      });
      expect(JSON.stringify(result)).not.toContain(peerId);
    },
  );

  it("does not use a direct display name for an opaque provider thread", () => {
    const peerId = "person@example.com";
    const result = presentation({
      key: "agent:main:provider-owned-key:thread:reply",
      isMain: false,
      channel: "custom-channel",
      entry: entry({ chatType: "direct", displayName: peerId }),
      displayName: peerId,
    });

    expect(result).toMatchObject({
      title: "Custom-channel thread",
      titleSource: "generated",
      family: "thread",
    });
    expect(JSON.stringify(result)).not.toContain(peerId);
  });

  it("projects group and thread families with an opaque base key", () => {
    expect(
      presentation({
        key: "agent:ops:discord:group:dev",
        isMain: false,
        entry: entry({ displayName: "Developer chat" }),
        displayName: "Developer chat",
      }),
    ).toMatchObject({ family: "group", title: "Developer chat", channel: "discord" });

    expect(
      presentation({
        key: "agent:ops:explicit:work:thread:launch",
        isMain: false,
        entry: entry(),
      }),
    ).toMatchObject({ family: "thread" });

    const routedThread = presentation({
      key: "agent:ops:telegram:main:direct:491234567890:thread:launch",
      isMain: false,
      entry: entry(),
    });
    expect(JSON.stringify(routedThread)).not.toContain("491234567890");

    const legacyDirectThread = presentation({
      key: "agent:ops:direct:491234567890:thread:launch",
      isMain: false,
      entry: entry(),
    });
    expect(JSON.stringify(legacyDirectThread)).not.toContain("491234567890");
  });

  it("uses stored group metadata when a provider key is not a delivery route", () => {
    expect(
      presentation({
        key: "provider-owned-room-key",
        isMain: false,
        channel: "custom-channel",
        entry: entry({ chatType: "group" }),
      }),
    ).toMatchObject({ family: "group", channel: "custom-channel" });

    expect(
      presentation({
        key: "provider-owned-direct-key",
        isMain: false,
        channel: "custom-channel",
        entry: entry({ chatType: "direct" }),
      }),
    ).toMatchObject({ family: "direct", title: "Custom-channel direct message" });
  });

  it("uses the persisted heartbeat marker instead of guessing from a suffix", () => {
    expect(
      presentation({
        key: "agent:main:alerts:heartbeat",
        isMain: false,
        entry: entry(),
      }).family,
    ).toBe("custom");

    expect(
      presentation({
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
      presentation({
        key: "agent:main:subagent:child",
        isMain: false,
        entry: entry({ label: "Research" }),
        displayName: "Research",
      }).title,
    ).toBe("Research");
    expect(
      presentation({
        key: "agent:main:subagent:child",
        isMain: false,
        entry: entry({ label: "Research" }),
        displayName: "Research",
      }).titleSource,
    ).toBe("label");
    expect(
      presentation({
        key: "agent:main:explicit:model-run-01234567-89ab-cdef-0123-456789abcdef",
        isMain: false,
        entry: entry(),
      }).title,
    ).toBe("model-run-…cdef");
  });
});
