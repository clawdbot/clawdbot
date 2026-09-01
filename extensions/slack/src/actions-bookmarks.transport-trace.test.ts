// Real-transport behavior proof for the Slack bookmark action surface.
//
// Drives the REAL Slack channel-action adapter entry point
// (`createSlackActions().handleAction`, the same `ChannelMessageActionAdapter`
// the core message-action dispatcher invokes for the Slack channel) through the
// real lazy-loaded action runtime (gate, operation token resolution,
// read-target authorization) into the real `actions-bookmarks` module, which
// calls the REAL `@slack/web-api` `WebClient`. The WebClient is pointed at an
// ephemeral loopback HTTP server via `SLACK_API_URL`, so every bookmarks.*
// call is a real HTTP POST with a real URL-encoded form body — not a recording
// stand-in. The server captures the exact method (URL path) and parsed form
// arguments, proving the after-fix wire contract through the real SDK transport.
//
// With OPENCLAW_BOOKMARK_PROOF=1 the scenario emits a `kind: "live-transport"`
// verdict JSON on stdout for pasting into the PR body.
import { createServer } from "node:http";
import type { Socket } from "node:net";
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSlackActions } from "./channel-actions.js";

const TEST_ENV_KEYS = [
  "SLACK_API_URL",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "https_proxy",
  "http_proxy",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
  "OPENCLAW_PROXY_ACTIVE",
  "OPENCLAW_PROXY_CA_FILE",
] as const;

type WireCall = {
  method: string;
  args: Record<string, unknown>;
};

type TestServer = {
  apiUrl: string;
  close(): Promise<void>;
};

function slackConfig(overrides?: Record<string, unknown>): OpenClawConfig {
  return {
    channels: {
      slack: {
        botToken: "xoxb-transport-trace",
        // Bookmark gate is default-off in production (existing installs lack the
        // scope); the transport-trace harness models a reinstalled, scope-granted
        // app so the real SDK transport is exercised on the happy path.
        actions: { bookmarks: true },
        ...overrides,
      },
    },
  } as OpenClawConfig;
}

// Parse the URL-encoded form body the @slack/web-api WebClient sends for a
// bookmarks.* call into its key/value arguments.
function parseFormBody(raw: string): Record<string, unknown> {
  const parsed: Record<string, unknown> = {};
  for (const pair of raw.split("&")) {
    const [key, value] = pair.split("=");
    if (key === undefined) {
      continue;
    }
    parsed[decodeURIComponent(key.replace(/\+/g, " "))] = decodeURIComponent(
      (value ?? "").replace(/\+/g, " "),
    );
  }
  return parsed;
}

async function startTransportServer(calls: WireCall[]): Promise<TestServer> {
  const server = createServer((request, response) => {
    const url = request.url ?? "";
    const method = url.replace(/^\/api\//, "");
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.once("end", () => {
      const parsed = parseFormBody(Buffer.concat(chunks).toString("utf8"));
      calls.push({ method, args: parsed });
      const payload = respondTo(method, parsed);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(`${JSON.stringify(payload)}\n`);
    });
  });
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Slack transport trace server did not bind a TCP address");
  }
  return {
    apiUrl: `http://127.0.0.1:${address.port}/api/`,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function respondTo(method: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (method) {
    case "auth.test":
      return { ok: true, user_id: "U0BOT", team: "T123", url: "https://trace.slack.com/" };
    case "conversations.info":
      return {
        ok: true,
        channel: { id: args.channel ?? args.channel_id, is_channel: true, name: "current" },
      };
    case "bookmarks.add":
      return {
        ok: true,
        bookmark: { id: "B001", title: args.title, link: args.link, type: "link" },
      };
    case "bookmarks.list":
      return {
        ok: true,
        bookmarks: [{ id: "B001", title: "Runbook", link: "https://runbook.example" }],
      };
    case "bookmarks.edit":
      return { ok: true, bookmark: { id: args.bookmark_id, title: args.title } };
    case "bookmarks.remove":
      return { ok: true };
    default:
      return { ok: false, error: "unknown_method" };
  }
}

const originalEnv = Object.fromEntries(TEST_ENV_KEYS.map((key) => [key, process.env[key]]));

function clearSlackTransportEnv(): void {
  for (const key of TEST_ENV_KEYS) {
    delete process.env[key];
  }
}

function restoreSlackTransportEnv(): void {
  for (const key of TEST_ENV_KEYS) {
    const original = originalEnv[key];
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
}

const adapter = createSlackActions("slack");
// createSlackActions always returns an adapter with a handleAction entry; the
// ChannelMessageActionAdapter type marks it optional because not every adapter
// handles actions, so narrow it once here.
const handleAction = adapter.handleAction!;
if (!handleAction) {
  throw new Error("Slack channel action adapter is missing its handleAction entry");
}

function actionContext(
  cfg: OpenClawConfig,
  params: Record<string, unknown>,
): ChannelMessageActionContext {
  return {
    channel: "slack",
    action: "bookmark",
    cfg,
    params,
    accountId: "default",
    requesterAccountId: "default",
    conversationReadOrigin: "delegated",
    toolContext: {
      currentChannelProvider: "slack",
      currentChannelId: "team:T123:channel:C123",
    },
  };
}

async function runBookmarkScenario(
  params: Record<string, unknown>,
  cfg: OpenClawConfig = slackConfig(),
): Promise<{ result?: AgentToolResult<unknown>; calls: WireCall[]; error?: Error }> {
  const calls: WireCall[] = [];
  const server = await startTransportServer(calls);
  process.env.SLACK_API_URL = server.apiUrl;
  try {
    const result = await handleAction(actionContext(cfg, params));
    return { result, calls: [...calls], error: undefined };
  } catch (error) {
    return { result: undefined, calls: [...calls], error: error as Error };
  } finally {
    await server.close();
  }
}

// A bookmark action succeeds when handleAction returns a result whose
// jsonResult payload reports ok: true. A wire call recorded before a later
// rejection would still populate calls, so the proof asserts this too.
function resultOk(scenario: { result?: AgentToolResult<unknown>; error?: Error }): boolean {
  if (scenario.error || !scenario.result) {
    return false;
  }
  const details = scenario.result.details as { ok?: unknown } | undefined;
  return details?.ok === true;
}

function buildBookmarkProofVerdict(
  scenarios: {
    name: string;
    calls: WireCall[];
    gateDisabled: boolean;
    returnedOk?: boolean;
    error?: string;
  }[],
  headSha: string,
): Record<string, unknown> {
  return {
    kind: "live-transport",
    liveSlack: false,
    harness: "extensions/slack/src/actions-bookmarks.transport-trace.test.ts",
    channel: "slack",
    headSha,
    environment: {
      node: process.version,
      platform: process.platform,
      slackApi: "real @slack/web-api WebClient HTTP POST to ephemeral loopback server",
      transport: "real SDK fetch; SLACK_API_URL redirected to 127.0.0.1",
      dispatch:
        "real createSlackActions().handleAction adapter -> lazy action-runtime -> actions-bookmarks",
      resultAssertion:
        "each happy-path scenario asserts error is absent and the returned AgentToolResult details.ok is true",
    },
    scenarios: scenarios.map((s) => ({
      name: s.name,
      gateDisabled: s.gateDisabled,
      returnedOk: s.returnedOk,
      outMethods: s.calls.map((c) => c.method),
      wireCalls: s.calls,
      ...(s.error ? { error: s.error } : {}),
    })),
  };
}

describe("Slack bookmark action real-transport trace", () => {
  const headSha = process.env.OPENCLAW_BOOKMARK_PROOF_SHA ?? "";

  beforeEach(() => {
    clearSlackTransportEnv();
  });

  afterEach(() => {
    restoreSlackTransportEnv();
  });

  it("routes bookmark add through the real SDK transport to a bookmarks.add HTTP POST", async () => {
    const { result, error, calls } = await runBookmarkScenario({
      op: "add",
      channelId: "C123",
      title: "Runbook",
      link: "https://runbook.example",
      emoji: "bookmark",
    });
    // The action must complete successfully: a wire call can be recorded before
    // a later SDK/action rejection, so assert the returned result as well.
    expect(error).toBeUndefined();
    expect(result?.details).toMatchObject({ ok: true, bookmark: { id: "B001" } });
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "bookmarks.add",
          args: expect.objectContaining({
            channel_id: "C123",
            title: "Runbook",
            link: "https://runbook.example",
            type: "link",
            emoji: ":bookmark:",
          }),
        }),
      ]),
    );
  });

  it("routes bookmark list through the real SDK transport to a bookmarks.list HTTP POST", async () => {
    const { result, error, calls } = await runBookmarkScenario({ channelId: "C123" });
    expect(error).toBeUndefined();
    expect(result?.details).toMatchObject({ ok: true, bookmarks: [{ id: "B001" }] });
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "bookmarks.list",
          args: expect.objectContaining({ channel_id: "C123" }),
        }),
      ]),
    );
  });

  it("routes bookmark edit through the real SDK transport to a bookmarks.edit HTTP POST", async () => {
    const { result, error, calls } = await runBookmarkScenario({
      op: "edit",
      channelId: "C123",
      bookmarkId: "B001",
      title: "Updated",
      emoji: "rotating_light",
    });
    expect(error).toBeUndefined();
    expect(result?.details).toMatchObject({ ok: true, bookmark: { id: "B001", title: "Updated" } });
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "bookmarks.edit",
          args: expect.objectContaining({
            channel_id: "C123",
            bookmark_id: "B001",
            title: "Updated",
            emoji: ":rotating_light:",
          }),
        }),
      ]),
    );
  });

  it("routes bookmark remove through the real SDK transport to a bookmarks.remove HTTP POST", async () => {
    const { result, error, calls } = await runBookmarkScenario({
      op: "remove",
      channelId: "C123",
      bookmarkId: "B001",
    });
    expect(error).toBeUndefined();
    expect(result?.details).toMatchObject({ ok: true });
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "bookmarks.remove",
          args: expect.objectContaining({ channel_id: "C123", bookmark_id: "B001" }),
        }),
      ]),
    );
  });

  it("fails closed with no HTTP call when the bookmarks gate is disabled", async () => {
    const { calls, error } = await runBookmarkScenario(
      { op: "add", channelId: "C123", title: "Runbook", link: "https://runbook.example" },
      slackConfig({ actions: { bookmarks: false } }),
    );
    expect(error?.message).toBe("Slack bookmarks are disabled.");
    expect(calls).toEqual([]);
  });

  it("rejects a bookmark list on a non-allowlisted channel before any HTTP call", async () => {
    const { calls, error } = await runBookmarkScenario(
      { channelId: "C999" },
      slackConfig({ channels: { C999: { enabled: false } } }),
    );
    expect(error?.message).toBe("Slack read target channel is not allowed.");
    expect(calls).toEqual([]);
  });

  it("emits a kind=live-transport verdict JSON when OPENCLAW_BOOKMARK_PROOF=1", async () => {
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
        { name: "add", calls: add.calls, gateDisabled: false, returnedOk: resultOk(add) },
        { name: "list", calls: list.calls, gateDisabled: false, returnedOk: resultOk(list) },
        { name: "edit", calls: edit.calls, gateDisabled: false, returnedOk: resultOk(edit) },
        { name: "remove", calls: remove.calls, gateDisabled: false, returnedOk: resultOk(remove) },
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
    expect(verdict.kind).toBe("live-transport");
    expect(verdict.liveSlack).toBe(false);
    if (process.env.OPENCLAW_BOOKMARK_PROOF === "1") {
      process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
    }
  });
});
