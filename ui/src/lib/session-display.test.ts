import { describe, expect, it } from "vitest";
import {
  channelDisplayLabel,
  resolveChannelSessionInfo,
  resolveSessionDisplayName,
  resolveSessionWorkSubtitle,
} from "./session-display.ts";

describe("resolveSessionDisplayName", () => {
  it("prefers label, then displayName", () => {
    expect(
      resolveSessionDisplayName("agent:main:telegram:direct:42", {
        label: "Alice",
        displayName: "openclaw-tui",
      }),
    ).toBe("Alice");
    expect(
      resolveSessionDisplayName("agent:main:telegram:direct:42", { displayName: "Peter" }),
    ).toBe("Peter");
  });

  it("never renders full raw peer ids for unnamed DMs", () => {
    expect(resolveSessionDisplayName("agent:main:telegram:direct:491234567890")).toBe(
      "Telegram · …567890",
    );
    expect(resolveSessionDisplayName("agent:main:imessage:direct:+4912")).toBe("iMessage · +4912");
  });

  it("falls back to a friendly name for dashboard sessions instead of the uuid key", () => {
    expect(
      resolveSessionDisplayName("agent:main:dashboard:0f9d5c1e-6d0f-4c9a-9d84-1c2f3a4b5c6d"),
    ).toBe("New session");
  });

  it("names unnamed work sessions after their checkout", () => {
    expect(
      resolveSessionDisplayName("agent:main:dashboard:uuid", {
        worktree: { branch: "openclaw/wt-3f2a", repoRoot: "/Users/dev/Projects/clawdbot" },
      }),
    ).toBe("clawdbot ⎇ wt-3f2a");
  });

  it("names named subsessions after their slug, never the raw agent key", () => {
    expect(resolveSessionDisplayName("agent:main:node-proof-claude")).toBe("node-proof-claude");
    expect(resolveSessionDisplayName("agent:main:explicit:node-mcp-debug")).toBe("node-mcp-debug");
    expect(
      resolveSessionDisplayName(
        "agent:main:explicit:model-run-0f9d5c1e-6d0f-4c9a-9d84-1c2f3a4b5c6d",
      ),
    ).toBe("model-run-…5c6d");
    expect(resolveSessionDisplayName("agent:main:node-fleet-4de003fbff138fcb9239c9378b2e")).toBe(
      "node-fleet-…8b2e",
    );
  });
});

describe("resolveSessionWorkSubtitle", () => {
  it("combines repo, branch, and node host", () => {
    expect(
      resolveSessionWorkSubtitle({
        worktree: { branch: "openclaw/session-ui", repoRoot: "/repo/clawdbot" },
      }),
    ).toBe("clawdbot ⎇ session-ui");
    expect(
      resolveSessionWorkSubtitle({
        worktree: { branch: "feature/x", repoRoot: "/repo/clawdbot" },
        execNode: "macbook",
      }),
    ).toBe("clawdbot ⎇ feature/x · macbook");
    expect(resolveSessionWorkSubtitle({ execNode: "macbook" })).toBe("macbook");
    expect(resolveSessionWorkSubtitle({})).toBeUndefined();
  });

  it("shortens opaque node ids instead of rendering raw hashes", () => {
    expect(
      resolveSessionWorkSubtitle({ execNode: "11c38726acc6fac280357576c87acc6fac280357" }),
    ).toBe("…0357");
    expect(
      resolveSessionWorkSubtitle({
        worktree: { branch: "openclaw/wt-1", repoRoot: "/repo/clawdbot" },
        execNode: "11c38726acc6fac280357576c87acc6fac280357",
      }),
    ).toBe("clawdbot ⎇ wt-1 · …0357");
  });
});

describe("resolveChannelSessionInfo", () => {
  it("classifies channel-shaped keys and keeps main/dashboard out", () => {
    expect(resolveChannelSessionInfo("agent:main:telegram:group:99")).toEqual({
      channel: "telegram",
      channelSession: true,
    });
    expect(resolveChannelSessionInfo("agent:main:slack:acct-1:channel:C1")).toEqual({
      channel: "slack",
      channelSession: true,
    });
    // dmScope per-peer keys have no channel segment; the row channel wins.
    expect(resolveChannelSessionInfo("agent:main:direct:+123", "whatsapp")).toEqual({
      channel: "whatsapp",
      channelSession: true,
    });
    expect(resolveChannelSessionInfo("agent:main:main", "telegram")).toEqual({
      channelSession: false,
    });
    expect(resolveChannelSessionInfo("agent:main:dashboard:uuid")).toEqual({
      channelSession: false,
    });
  });
});

describe("channelDisplayLabel", () => {
  it("uses friendly names for known channels and capitalizes the rest", () => {
    expect(channelDisplayLabel("imessage")).toBe("iMessage");
    expect(channelDisplayLabel("telegram")).toBe("Telegram");
    expect(channelDisplayLabel("mattermost")).toBe("Mattermost");
  });
});
