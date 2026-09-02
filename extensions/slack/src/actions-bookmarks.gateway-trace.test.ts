// Mock-gateway harness proof for the Slack bookmark action surface.
//
// Drives the REAL Slack action dispatch wiring — the plugin handleAction entry
// (handleSlackMessageAction, which maps the portable `bookmark` action + `op`
// to the internal add/list/edit/remove actions) → handleSlackAction action
// runtime (action gate, operation token resolution, read-target authorization)
// → the real actions-bookmarks module → client.bookmarks.* — by routing every
// WebClient resolution through a recording stand-in via vi.mock("./client.js"),
// the same recording-WebClient technique the repo's delivery-trace harness uses.
//
// This is not a leaf-function injection: the recording client captures the
// exact bookmarks.add/list/edit/remove wire calls and arguments AFTER the action
// passes the same gate, token, op-mapping, and read-authority checks the
// operator's gateway would exercise. The gate-disabled case fails closed before
// any wire call, proving the parsed-config gate is enforced on the real path.
//
// With OPENCLAW_BOOKMARK_PROOF=1 the scenario emits a `kind: "mock-gateway"`
// verdict JSON on stdout for pasting into the PR body.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

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

const { handleSlackMessageAction } = await import("./message-action-dispatch.js");

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

function actionContext(
  cfg: OpenClawConfig,
  params: Record<string, unknown>,
): Parameters<typeof handleSlackMessageAction>[0]["ctx"] {
  return {
    channel: "slack",
    action: "bookmark",
    cfg,
    params,
    accountId: "default",
    requesterAccountId: "default",
    toolContext: {
      currentChannelProvider: "slack",
      currentChannelId: "team:T123:channel:C123",
    },
  };
}

async function runBookmarkScenario(params: Record<string, unknown>, cfg = slackConfig()) {
  traceState.calls = [];
  traceState.client = recordingClient();
  try {
    const result = await handleSlackMessageAction({
      providerId: "slack",
      ctx: actionContext(cfg, params),
      normalizeChannelId: (id) => id,
      invoke: async (action, invokeCfg, toolContext) => {
        const { handleSlackAction } = await import("./action-runtime.js");
        // handleSlackAction's context is SlackActionContext (requesterAccountId +
        // currentChannelProvider/Id), which channel-actions.ts derives from the
        // host-owned ctx via resolveSlackActionContext. toolContext here is the
        // narrower ChannelThreadingToolContext, so forward the trusted fields
        // the bookmark read-target check needs alongside the threading context.
        const context = {
          ...toolContext,
          requesterAccountId: "default",
        };
        return await handleSlackAction(action, invokeCfg, context);
      },
    });
    return { result, calls: [...traceState.calls], error: undefined as Error | undefined };
  } catch (error) {
    return { result: undefined, calls: [...traceState.calls], error: error as Error };
  }
}

function buildBookmarkProofVerdict(
  scenarios: {
    name: string;
    calls: WireCall[];
    gateDisabled: boolean;
    error?: string;
  }[],
  headSha: string,
): Record<string, unknown> {
  return {
    kind: "mock-gateway",
    liveSlack: false,
    harness: "extensions/slack/src/actions-bookmarks.gateway-trace.test.ts",
    channel: "slack",
    headSha,
    environment: {
      node: process.version,
      platform: process.platform,
      slackApi: "recording WebClient",
      dispatch:
        "real handleSlackMessageAction op-mapping + handleSlackAction gate/token/target-check",
    },
    scenarios: scenarios.map((s) => ({
      name: s.name,
      gateDisabled: s.gateDisabled,
      outMethods: s.calls.map((c) => c.method),
      wireCalls: s.calls,
      ...(s.error ? { error: s.error } : {}),
    })),
  };
}

describe("Slack bookmark action mock-gateway trace", () => {
  const headSha = process.env.OPENCLAW_BOOKMARK_PROOF_SHA ?? "";

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("routes bookmark add through the Slack action dispatcher to bookmarks.add", async () => {
    const { calls } = await runBookmarkScenario({
      op: "add",
      channelId: "C123",
      title: "Runbook",
      link: "https://runbook.example",
      emoji: "bookmark",
    });
    expect(calls).toEqual([
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
  });

  it("routes bookmark list through the Slack action dispatcher to bookmarks.list", async () => {
    const { calls } = await runBookmarkScenario({ channelId: "C123" });
    expect(calls).toEqual([{ method: "bookmarks.list", args: { channel_id: "C123" } }]);
  });

  it("routes bookmark edit through the Slack action dispatcher to bookmarks.edit", async () => {
    const { calls } = await runBookmarkScenario({
      op: "edit",
      channelId: "C123",
      bookmarkId: "B001",
      title: "Updated",
      emoji: "rotating_light",
    });
    expect(calls).toEqual([
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
  });

  it("routes bookmark remove through the Slack action dispatcher to bookmarks.remove", async () => {
    const { calls } = await runBookmarkScenario({
      op: "remove",
      channelId: "C123",
      bookmarkId: "B001",
    });
    expect(calls).toEqual([
      { method: "bookmarks.remove", args: { channel_id: "C123", bookmark_id: "B001" } },
    ]);
  });

  it("fails closed with no wire call when the bookmarks gate is disabled", async () => {
    const { calls, error } = await runBookmarkScenario(
      { op: "add", channelId: "C123", title: "Runbook", link: "https://runbook.example" },
      slackConfig({ actions: { bookmarks: false } }),
    );
    expect(error?.message).toBe("Slack bookmarks are disabled.");
    expect(calls).toEqual([]);
  });

  it("rejects a bookmark list on a non-allowlisted channel before any wire call", async () => {
    // The current conversation is C123 (authorized). A delegated read targeting
    // C999, which the channel policy explicitly disables, must be denied by the
    // same assertSlackReadTargetAllowed gate the pin/list read path uses before
    // any bookmarks.* wire call reaches the recording WebClient.
    const { calls, error } = await runBookmarkScenario(
      { channelId: "C999" },
      slackConfig({ channels: { C999: { enabled: false } } }),
    );
    expect(error?.message).toBe("Slack read target channel is not allowed.");
    expect(calls).toEqual([]);
  });

  it("emits a kind=mock-gateway verdict JSON when OPENCLAW_BOOKMARK_PROOF=1", async () => {
    const add = await runBookmarkScenario({
      op: "add",
      channelId: "C123",
      title: "Runbook",
      link: "https://runbook.example",
      emoji: "bookmark",
    });
    const list = await runBookmarkScenario({ channelId: "C123" });
    const edit = await runBookmarkScenario({
      op: "edit",
      channelId: "C123",
      bookmarkId: "B001",
      title: "Updated",
      emoji: "rotating_light",
    });
    const remove = await runBookmarkScenario({
      op: "remove",
      channelId: "C123",
      bookmarkId: "B001",
    });
    const gated = await runBookmarkScenario(
      { op: "add", channelId: "C123", title: "Runbook", link: "https://runbook.example" },
      slackConfig({ actions: { bookmarks: false } }),
    );
    const unauthorized = await runBookmarkScenario(
      { channelId: "C999" },
      slackConfig({ channels: { C999: { enabled: false } } }),
    );
    const verdict = buildBookmarkProofVerdict(
      [
        { name: "add", calls: add.calls, gateDisabled: false },
        { name: "list", calls: list.calls, gateDisabled: false },
        { name: "edit", calls: edit.calls, gateDisabled: false },
        { name: "remove", calls: remove.calls, gateDisabled: false },
        {
          name: "gate-disabled",
          calls: gated.calls,
          gateDisabled: true,
          error: gated.error?.message,
        },
        {
          name: "unauthorized-target",
          calls: unauthorized.calls,
          gateDisabled: false,
          error: unauthorized.error?.message,
        },
      ],
      headSha,
    );
    expect(verdict.kind).toBe("mock-gateway");
    expect(verdict.liveSlack).toBe(false);
    if (process.env.OPENCLAW_BOOKMARK_PROOF === "1") {
      process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
    }
  });
});
