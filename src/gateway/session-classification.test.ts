import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { sessionClassificationForRow } from "./session-classification.js";

function entry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return { sessionId: "session", updatedAt: 1, ...overrides };
}

function classification(params: {
  key: string;
  isMain: boolean;
  agentId?: string;
  entry?: SessionEntry;
}) {
  const cfg = {
    agents: { list: [{ id: "main", default: true }] },
    ...(params.isMain ? {} : { session: { mainKey: "not-main" } }),
  } as OpenClawConfig;
  return sessionClassificationForRow(cfg, params.key, params.agentId ?? "main", params.entry);
}

describe("sessionClassificationForRow", () => {
  it.each([
    ["agent:main:main", true, "main", false],
    ["agent:main:dashboard:01234567-89ab-cdef-0123-456789abcdef", false, "dashboard", false],
    ["agent:main:tui-01234567-89ab-cdef-0123-456789abcdef", false, "tui", false],
    ["agent:main:subagent:child", false, "subagent", true],
    ["agent:main:acp:child", false, "acp", true],
    ["agent:main:cron:job", false, "cron", true],
    ["agent:main:hook:run", false, "hook", true],
    ["agent:main:node-device", false, "node", false],
    ["agent:main:harness:codex:supervision:thread", false, "harness", true],
    ["agent:main:voice:call:123", false, "voice", false],
    ["agent:main:dreaming-narrative-rem-workspace", false, "dreaming", true],
  ] as const)("classifies %s", (key, isMain, expected, isBackground) => {
    expect(classification({ key, isMain, entry: entry() })).toMatchObject({
      classification: expected,
      isBackground,
      isMain,
    });
  });

  it("canonicalizes structural casing while preserving opaque peer ids", () => {
    expect(
      classification({
        key: "AGENT:MAIN:MAIN",
        isMain: true,
        entry: entry(),
      }),
    ).toMatchObject({ classification: "main", agentId: "main", isMain: true });
    expect(
      classification({
        key: "AGENT:MAIN:TELEGRAM:MAIN:DIRECT:491234567890",
        isMain: false,
        entry: entry(),
      }),
    ).toMatchObject({ classification: "direct", accountId: "main", peerKind: "direct" });
    expect(
      sessionClassificationForRow(
        { session: { scope: "global" } } as OpenClawConfig,
        "GLOBAL",
        "main",
        entry(),
      ),
    ).toMatchObject({ classification: "global", isMain: true });
    expect(classification({ key: "UNKNOWN", isMain: false, entry: entry() })).toMatchObject({
      classification: "unknown",
      isMain: false,
    });
  });

  it("projects routing facts without exposing the peer id", () => {
    const result = classification({
      key: "agent:main:telegram:main:direct:491234567890",
      isMain: false,
      entry: entry(),
    });

    expect(result).toMatchObject({
      classification: "direct",
      agentId: "main",
      accountId: "main",
      peerKind: "direct",
      isBackground: false,
    });
    expect(JSON.stringify(result)).not.toContain("491234567890");
  });

  it("lets persisted spawn ownership override a delivery-shaped key", () => {
    expect(
      classification({
        key: "agent:main:telegram:main:direct:491234567890",
        isMain: false,
        entry: entry({ spawnedBy: "agent:main:main" }),
      }),
    ).toMatchObject({
      classification: "subagent",
      accountId: "main",
      peerKind: "direct",
      isBackground: true,
    });
  });

  it("classifies stored chat type when a provider key is not a delivery route", () => {
    expect(
      classification({
        key: "provider-owned-room-key",
        isMain: false,
        entry: entry({ chatType: "group" }),
      }),
    ).toMatchObject({ classification: "group" });
  });

  it("uses the persisted heartbeat marker instead of guessing from a suffix", () => {
    expect(
      classification({ key: "agent:main:alerts:heartbeat", isMain: false, entry: entry() })
        .classification,
    ).toBe("custom");
    expect(
      classification({
        key: "agent:main:alerts:heartbeat",
        isMain: false,
        entry: entry({ heartbeatIsolatedBaseSessionKey: "agent:main:alerts" }),
      }),
    ).toMatchObject({ classification: "heartbeat", isBackground: true });
  });
});
