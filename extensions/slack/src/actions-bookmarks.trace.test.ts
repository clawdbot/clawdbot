// Real-behavior proof for Slack channel bookmarks.
// Drives the real production path (handleSlackAction action-runtime gating +
// token resolution + read-target authorization + actions.ts) by routing every
// WebClient resolution through a recording stand-in. The recording client
// captures the exact bookmarks.add/list/edit/remove wire calls and arguments
// end-to-end, so the proof covers the full dispatch path the operator's gateway
// would exercise, not just the leaf actions.ts functions.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

type WireCall = {
  method: string;
  args: Record<string, unknown>;
};

const traceState = vi.hoisted(() => ({
  calls: [] as WireCall[],
  client: null as Record<string, unknown> | null,
}));

vi.mock("./client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client.js")>();
  const traceClient = () => {
    if (!traceState.client) {
      throw new Error("trace Slack client not initialized");
    }
    return traceState.client as never;
  };
  return {
    ...actual,
    createSlackLookupClient: traceClient,
    createSlackReadClient: traceClient,
    createSlackWebClient: traceClient,
    createSlackWriteClient: traceClient,
    getSlackWriteClient: traceClient,
  };
});

const { handleSlackAction } = await import("./action-runtime.js");
type TraceResult = Awaited<ReturnType<typeof handleSlackAction>>;

function recordingClient(): Record<string, unknown> {
  const record = (method: string, args: Record<string, unknown>) => {
    traceState.calls.push({ method, args });
  };
  return {
    auth: {
      test: async () => ({ ok: true, user_id: "U0BOT" }),
    },
    conversations: {
      info: async (args: Record<string, unknown>) => ({
        ok: true,
        channel: { id: args.channel, is_channel: true, name: "current" },
      }),
    },
    bookmarks: {
      add: async (args: Record<string, unknown>) => {
        record("bookmarks.add", args);
        return { ok: true, bookmark: { id: "B001", title: args.title, link: args.link } };
      },
      list: async (args: Record<string, unknown>) => {
        record("bookmarks.list", args);
        return {
          ok: true,
          bookmarks: [{ id: "B001", title: "Runbook", link: "https://runbook.example" }],
        };
      },
      edit: async (args: Record<string, unknown>) => {
        record("bookmarks.edit", args);
        return { ok: true, bookmark: { id: args.bookmark_id, title: args.title } };
      },
      remove: async (args: Record<string, unknown>) => {
        record("bookmarks.remove", args);
        return { ok: true };
      },
    },
  };
}

function slackConfig(overrides?: Record<string, unknown>): OpenClawConfig {
  return {
    channels: {
      slack: {
        botToken: "xoxb-trace",
        // Bookmark gate is default-off in production (existing installs lack the
        // scope); the trace harness models a reinstalled, scope-granted app.
        actions: { bookmarks: true },
        ...overrides,
      },
    },
  } as OpenClawConfig;
}

const trustedContext = {
  currentChannelProvider: "slack",
  currentChannelId: "team:T123:channel:C123",
  requesterAccountId: "default",
};

function detailsOf(result: TraceResult): Record<string, unknown> {
  const text = result.content[0];
  return JSON.parse(
    typeof text === "object" && text && "text" in text ? ((text.text as string) ?? "{}") : "{}",
  );
}

describe("Slack channel bookmark real-behavior trace", () => {
  beforeEach(() => {
    traceState.calls = [];
    traceState.client = recordingClient();
  });

  it("routes addChannelBookmark through the action runtime to bookmarks.add", async () => {
    const result = await handleSlackAction(
      {
        action: "addChannelBookmark",
        channelId: "C123",
        title: "Runbook",
        link: "https://runbook.example",
        emoji: "bookmark",
      },
      slackConfig(),
      trustedContext,
    );

    expect(traceState.calls).toEqual([
      {
        method: "bookmarks.add",
        args: {
          channel_id: "C123",
          title: "Runbook",
          link: "https://runbook.example",
          type: "link",
          emoji: ":bookmark:",
        },
      },
    ]);
    expect(detailsOf(result)).toMatchObject({
      ok: true,
      bookmark: { id: "B001", title: "Runbook" },
    });
  });

  it("normalizes a colon-wrapped bookmark emoji without double-wrapping", async () => {
    await handleSlackAction(
      {
        action: "addChannelBookmark",
        channelId: "C123",
        title: "Runbook",
        link: "https://runbook.example",
        emoji: ":pushpin:",
      },
      slackConfig(),
      trustedContext,
    );

    expect(traceState.calls).toEqual([
      {
        method: "bookmarks.add",
        args: {
          channel_id: "C123",
          title: "Runbook",
          link: "https://runbook.example",
          type: "link",
          emoji: ":pushpin:",
        },
      },
    ]);
  });

  it("omits the emoji field when the bookmark emoji is blank", async () => {
    await handleSlackAction(
      {
        action: "addChannelBookmark",
        channelId: "C123",
        title: "Runbook",
        link: "https://runbook.example",
        emoji: "  ",
      },
      slackConfig(),
      trustedContext,
    );

    expect(traceState.calls).toEqual([
      {
        method: "bookmarks.add",
        args: {
          channel_id: "C123",
          title: "Runbook",
          link: "https://runbook.example",
          type: "link",
        },
      },
    ]);
  });

  it("routes listChannelBookmarks through the action runtime to bookmarks.list", async () => {
    const result = await handleSlackAction(
      { action: "listChannelBookmarks", channelId: "C123" },
      slackConfig(),
      trustedContext,
    );

    expect(traceState.calls).toEqual([{ method: "bookmarks.list", args: { channel_id: "C123" } }]);
    expect(detailsOf(result)).toMatchObject({ ok: true, bookmarks: [{ id: "B001" }] });
  });

  it("routes editChannelBookmark through the action runtime to bookmarks.edit", async () => {
    const result = await handleSlackAction(
      {
        action: "editChannelBookmark",
        channelId: "C123",
        bookmarkId: "B001",
        title: "Updated",
        emoji: "rotating_light",
      },
      slackConfig(),
      trustedContext,
    );

    expect(traceState.calls).toEqual([
      {
        method: "bookmarks.edit",
        args: {
          channel_id: "C123",
          bookmark_id: "B001",
          title: "Updated",
          emoji: ":rotating_light:",
        },
      },
    ]);
    expect(detailsOf(result)).toMatchObject({ ok: true, bookmark: { id: "B001" } });
  });

  it("routes removeChannelBookmark through the action runtime to bookmarks.remove", async () => {
    const result = await handleSlackAction(
      { action: "removeChannelBookmark", channelId: "C123", bookmarkId: "B001" },
      slackConfig(),
      trustedContext,
    );

    expect(traceState.calls).toEqual([
      { method: "bookmarks.remove", args: { channel_id: "C123", bookmark_id: "B001" } },
    ]);
    expect(detailsOf(result)).toMatchObject({ ok: true });
  });

  it("fails closed before any bookmark wire call when the gate is disabled", async () => {
    const cfg = slackConfig({ actions: { bookmarks: false } });

    await expect(
      handleSlackAction({ action: "listChannelBookmarks", channelId: "C123" }, cfg, trustedContext),
    ).rejects.toThrow("Slack bookmarks are disabled.");
    expect(traceState.calls).toEqual([]);
  });
});
