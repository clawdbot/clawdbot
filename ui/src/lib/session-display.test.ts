// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  isCronSessionKey,
  resolveChannelSessionInfo,
  resolveSessionDisplayName,
  resolveSessionWorkContext,
  resolveSessionWorkSubtitle,
} from "./session-display.ts";

describe("isCronSessionKey", () => {
  it.each([
    ["cron:job", true],
    [" CRON:JOB ", true],
    ["agent:ops:cron:job", true],
    ["agent:ops:cron:job:run:one", true],
    ["agent:ops::cron:job", true],
    ["agent: :cron:job", true],
    ["agent:ops:cron:", false],
    ["agent:ops:cron::", false],
    ["agent::cron:job", false],
    [":agent:ops:cron:job", false],
    ["agent:ops:custom:cron:job", false],
    ["agent:ops:main", false],
    ["", false],
  ] as const)("retains automation classification for %j", (key, expected) => {
    expect(isCronSessionKey(key)).toBe(expected);
  });
});

describe("resolveSessionDisplayName", () => {
  it("uses the same friendly main-thread name for every agent", () => {
    for (const key of ["main", "agent:main:main", "agent:research:main", "agent:ops-team:main"]) {
      expect(resolveSessionDisplayName(key)).toBe("Main Session");
    }

    expect(resolveSessionDisplayName("agent:research:main", { displayName: "Research desk" })).toBe(
      "Research desk",
    );
    expect(resolveSessionDisplayName("agent:research:dashboard:main")).toBe("New session");
    expect(resolveSessionDisplayName("agent:research:main:thread")).toBe("main:thread");
  });

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

  // Rows are shaped like the Gateway projection: displayName plus the
  // accountId it derives from the canonical route, no user label.
  it.each([
    {
      name: "an account-less direct row keeps its plain name",
      key: "agent:main:telegram:direct:42",
      row: { displayName: "Alice" },
      expected: "Alice",
    },
    {
      name: "an account-qualified direct row names its account",
      key: "agent:main:telegram:cards:direct:42",
      row: { accountId: "cards", displayName: "Alice" },
      expected: "Alice · cards",
    },
    {
      name: "a shipped dm-spelled row names its account",
      key: "agent:main:telegram:cards:dm:42",
      row: { accountId: "cards", displayName: "Alice" },
      expected: "Alice · cards",
    },
    {
      name: "an unnamed shipped dm row reads as a friendly peer plus account",
      key: "agent:main:telegram:cards:dm:491234567890",
      row: { accountId: "cards" },
      expected: "Telegram · …567890 · cards",
    },
    {
      name: "the default account adds no discriminator",
      key: "agent:main:telegram:default:direct:42",
      row: { accountId: "default", displayName: "Alice" },
      expected: "Alice",
    },
    {
      name: "a human label that merely looks account-shaped still gets a discriminator",
      key: "agent:main:telegram:work:direct:42",
      row: { accountId: "work", label: "Alice (work)" },
      expected: "Alice (work) · work",
    },
    {
      name: "a stored label that already ends in the account suffix is left alone",
      key: "agent:main:telegram:cards:direct:42",
      row: { accountId: "cards", label: "Alice · cards" },
      expected: "Alice · cards",
    },
    {
      name: "a canonical group key is unchanged",
      key: "agent:main:telegram:group:-1001234567890",
      row: undefined,
      expected: "Telegram Group",
    },
    {
      name: "an account-looking group key is not read as an account-qualified group",
      key: "agent:main:dm:account:group:room",
      row: undefined,
      expected: "dm:account:group:room",
    },
  ])("$name", ({ key, row, expected }) => {
    expect(resolveSessionDisplayName(key, row)).toBe(expected);
  });

  it("reads the account off the key only until the gateway row arrives", () => {
    expect(resolveSessionDisplayName("agent:main:telegram:cards:direct:42")).toBe(
      "Telegram · 42 · cards",
    );
    expect(resolveSessionDisplayName("agent:main:signal:work:dm:+4912")).toBe(
      "Signal · +4912 · work",
    );
    expect(resolveSessionDisplayName("agent:main:telegram:default:direct:42")).toBe(
      "Telegram · 42",
    );
  });

  it("takes the account from the gateway row, not the key", () => {
    // Only the projection carries account identity here; the key has none.
    expect(
      resolveSessionDisplayName("agent:main:telegram:direct:42", {
        accountId: "cards",
        displayName: "Alice",
      }),
    ).toBe("Alice · cards");
    // When the two disagree, the route the Gateway parsed wins over the guess.
    expect(
      resolveSessionDisplayName("agent:main:telegram:cards:direct:42", {
        accountId: "ops",
        displayName: "Alice",
      }),
    ).toBe("Alice · ops");
  });

  it("does not split UTF-16 surrogate pairs when shortening peer ids", () => {
    expect(resolveSessionDisplayName("agent:main:telegram:direct:12345😀67890")).toBe(
      "Telegram · …67890",
    );
  });

  it("falls back to a friendly name for dashboard sessions instead of the uuid key", () => {
    const key = "agent:main:dashboard:0f9d5c1e-6d0f-4c9a-9d84-1c2f3a4b5c6d";

    expect(resolveSessionDisplayName(key)).toBe("New session");
    expect(
      resolveSessionDisplayName(key, {
        label: undefined,
        displayName: undefined,
        derivedTitle: undefined,
      }),
    ).toBe("New session");
  });

  it("names unnamed work sessions after their checkout", () => {
    expect(
      resolveSessionDisplayName("agent:main:dashboard:uuid", {
        worktree: { branch: "openclaw/wt-3f2a", repoRoot: "/Users/dev/Projects/clawdbot" },
      }),
    ).toBe("clawdbot ⎇ wt-3f2a");
  });

  it("uses a gateway-derived title for otherwise unnamed sessions", () => {
    expect(
      resolveSessionDisplayName("agent:main:dashboard:uuid", {
        label: "agent:main:dashboard:uuid",
        displayName: "agent:main:dashboard:uuid",
        derivedTitle: "Quarterly launch plan",
      }),
    ).toBe("Quarterly launch plan");
  });

  it("keeps explicit and worktree names ahead of derived titles", () => {
    expect(
      resolveSessionDisplayName("agent:main:dashboard:uuid", {
        label: "Release room",
        derivedTitle: "Quarterly launch plan",
      }),
    ).toBe("Release room");
    expect(
      resolveSessionDisplayName("agent:main:dashboard:uuid", {
        worktree: { branch: "openclaw/wt-3f2a", repoRoot: "/repo/clawdbot" },
        derivedTitle: "Quarterly launch plan",
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

  it("can omit only the subagent prefix while preserving its untitled fallback", () => {
    const key = "agent:main:subagent:worker";
    expect(resolveSessionDisplayName(key, { label: "Research sources" })).toBe(
      "Subagent: Research sources",
    );
    expect(
      resolveSessionDisplayName(
        key,
        { label: "Subagent: Research sources" },
        {
          includeSubagentPrefix: false,
        },
      ),
    ).toBe("Research sources");
    expect(resolveSessionDisplayName(key, undefined, { includeSubagentPrefix: false })).toBe(
      "Subagent:",
    );
    expect(
      resolveSessionDisplayName(
        "agent:main:cron:daily",
        { label: "Daily" },
        {
          includeSubagentPrefix: false,
        },
      ),
    ).toBe("Automation: Daily");
  });

  it("strips persisted pre-rename Cron labels instead of double-prefixing", () => {
    expect(
      resolveSessionDisplayName("agent:main:cron:daily", { label: "Cron: daily-report" }),
    ).toBe("Automation: daily-report");
    expect(resolveSessionDisplayName("agent:main:cron:daily", { label: "Cron Job: nightly" })).toBe(
      "Automation: nightly",
    );
  });
});

describe("resolveSessionWorkSubtitle", () => {
  it("combines repo, branch, and node host", () => {
    expect(
      resolveSessionWorkSubtitle({
        repository: {
          url: "https://github.com/openclaw/openclaw.git",
          branch: "openclaw/cloud-task",
        },
      }),
    ).toBe("openclaw ⎇ cloud-task");
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

describe("resolveSessionWorkContext", () => {
  it("projects only repository or authoritative workspace facts", () => {
    expect(
      resolveSessionWorkContext({
        worktree: { branch: "openclaw/session-ui", repoRoot: "/repo/openclaw" },
      }),
    ).toEqual({
      kind: "project",
      name: "openclaw",
      path: "/repo/openclaw",
      branch: "session-ui",
    });
    expect(
      resolveSessionWorkContext({
        spawnedWorkspaceDir: "/workspaces/release-notes",
        spawnedCwd: "/stale/cwd",
      }),
    ).toEqual({
      kind: "workspace",
      name: "release-notes",
      path: "/workspaces/release-notes",
    });
    expect(
      resolveSessionWorkContext({
        execNode: "remote-node",
        execCwd: "/remote/workspace",
        spawnedWorkspaceDir: "/local/workspace",
        worktree: { branch: "openclaw/local-branch", repoRoot: "/gateway/repo" },
      }),
    ).toEqual({ kind: "workspace", name: "workspace", path: "/remote/workspace" });
    expect(resolveSessionWorkContext({ execCwd: "/stale/local-routing-cwd" })).toBeUndefined();
  });
});

describe("resolveChannelSessionInfo", () => {
  it("classifies channel-shaped keys and keeps main/dashboard out", () => {
    expect(resolveChannelSessionInfo("agent:main:telegram:group:99")).toEqual({
      channel: "telegram",
      channelSession: true,
    });
    expect(resolveChannelSessionInfo("agent:main:slack:channel:C1")).toEqual({
      channel: "slack",
      channelSession: true,
    });
    // Shipped pre-#11881 keys spell direct chats `dm`; they are still channel sessions.
    expect(resolveChannelSessionInfo("agent:main:telegram:cards:dm:42")).toEqual({
      channel: "telegram",
      channelSession: true,
    });
    expect(resolveChannelSessionInfo("agent:main:dm:+123", "whatsapp")).toEqual({
      channel: "whatsapp",
      channelSession: true,
    });
    // Accounts qualify direct chats only, so these key shapes name no channel
    // and must not be filed under one the canonical parser would reject.
    expect(resolveChannelSessionInfo("agent:main:telegram:work:group:room")).toEqual({
      channelSession: false,
    });
    expect(resolveChannelSessionInfo("agent:main:slack:acct-1:channel:C1")).toEqual({
      channelSession: false,
    });
    expect(resolveChannelSessionInfo("agent:main:dm:account:group:room")).toEqual({
      channelSession: false,
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
