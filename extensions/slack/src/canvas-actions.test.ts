import { WebClient, type WebClientOptions } from "@slack/web-api";
import type {
  ChannelMessageActionContext,
  ChannelMessageActionName,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSlackActions } from "./channel-actions.js";
import * as slackClient from "./client.js";
import { registerSlackInstallationState } from "./installation-identity-state.js";

type SlackRequest = {
  method: string;
  args: Record<string, string>;
  authorization: string | null;
};

const CHANNEL_ID = "C01234567";
const CANVAS_ID = "F01234567";
const TEAM_ID = "T11111111";
const CREATE = { to: `channel:${CHANNEL_ID}`, canvasMarkdown: "# Shared plan" };
const EDIT = {
  to: `channel:${CHANNEL_ID}`,
  canvasId: CANVAS_ID,
  canvasOperation: "insert_at_end",
  canvasMarkdown: "A new decision",
};

function createCanvasFixture() {
  const requests: SlackRequest[] = [];
  const state = {
    info: {
      ok: true,
      channel: {
        id: CHANNEL_ID,
        is_channel: true,
        properties: { canvas: { file_id: CANVAS_ID } },
      },
    } as Record<string, unknown>,
    mutation: { ok: true, canvas_id: CANVAS_ID } as Record<string, unknown>,
    failMutationTransport: false,
  };
  const cfg: OpenClawConfig = {
    channels: {
      slack: {
        botToken: "xoxb-canvas-test",
        userToken: "xoxp-canvas-readonly",
        userTokenReadOnly: true,
        groupPolicy: "open",
        actions: { canvas: true },
      },
    },
  };
  const fetch: NonNullable<WebClientOptions["fetch"]> = async (input, init) => {
    if (typeof init?.body !== "string") {
      throw new Error("Expected a form-encoded Slack request body");
    }
    const method = new URL(String(input)).pathname.split("/").at(-1) ?? "";
    const args = Object.fromEntries(new URLSearchParams(init.body));
    requests.push({ method, args, authorization: new Headers(init?.headers).get("authorization") });
    if (
      method !== "conversations.info" &&
      method !== "conversations.canvases.create" &&
      method !== "canvases.edit"
    ) {
      throw new Error(`Unexpected Slack request: ${method}`);
    }
    if (method !== "conversations.info" && state.failMutationTransport) {
      throw new Error("Canvas response lost after mutation");
    }
    return new Response(
      JSON.stringify(method === "conversations.info" ? state.info : state.mutation),
      {
        headers: { "content-type": "application/json" },
      },
    );
  };
  vi.spyOn(slackClient, "getSlackWriteClient").mockImplementation(
    (token, options) =>
      new WebClient(token, slackClient.resolveSlackWriteClientOptions({ ...options, fetch })),
  );
  vi.spyOn(slackClient, "createSlackReadClient").mockImplementation(() => {
    throw new Error("Canvas association must be checked with the mutation identity");
  });
  const adapter = createSlackActions("slack");
  const invoke = (
    action: ChannelMessageActionName,
    params: Record<string, unknown>,
    overrides: Partial<ChannelMessageActionContext> = {},
  ) =>
    adapter.handleAction!({
      channel: "slack",
      action,
      cfg,
      params,
      accountId: "default",
      requesterAccountId: "default",
      toolContext: {
        currentChannelProvider: "slack",
        currentChannelId: `team:${TEAM_ID}:channel:${CHANNEL_ID}`,
        currentThreadTs: "170000.111",
        replyToMode: "first",
      },
      ...overrides,
    });
  return { adapter, cfg, invoke, requests, state };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Slack channel canvas actions", () => {
  it("keeps canvas actions hidden and rejects direct calls until explicitly enabled", async () => {
    const { adapter, cfg, invoke, requests } = createCanvasFixture();
    cfg.channels!.slack!.actions = undefined;

    const discovery = adapter.describeMessageTool({ cfg, accountId: "default" });
    expect(discovery?.actions).not.toContain("canvas-create");
    expect(discovery?.actions).not.toContain("canvas-edit");
    await expect(invoke("canvas-create", CREATE)).rejects.toThrow(
      "Slack canvas actions are disabled",
    );
    expect(requests).toEqual([]);
  });

  it("exposes canvas input contracts without classifying mutations as chat delivery", () => {
    const { adapter, cfg } = createCanvasFixture();
    const discovery = adapter.describeMessageTool({ cfg, accountId: "default" });
    const contributions = discovery?.schema;
    const schemas = Array.isArray(contributions) ? contributions : [contributions];
    for (const action of ["canvas-create", "canvas-edit"] as const) {
      expect(discovery?.actions).toContain(action);
      const properties = Object.assign(
        {},
        ...schemas
          .filter((entry) => entry?.actions?.includes(action))
          .map((entry) => entry?.properties),
      );
      expect(properties.canvasMarkdown).toMatchObject({ type: "string" });
      expect(adapter.extractToolSend!({ args: { action, ...CREATE } })).toBeNull();
    }
  });

  it("creates a channel canvas as the bot, preserves markdown, and leaves thread reply tracking alone", async () => {
    const { invoke, requests, state } = createCanvasFixture();
    state.info = { ok: true, channel: { id: CHANNEL_ID, is_channel: true } };
    const hasRepliedRef = { value: false };
    const markdown = "# Shared plan\n\n  Keep indentation\n";
    const result = await invoke(
      "canvas-create",
      { ...CREATE, canvasMarkdown: markdown, canvasTitle: "Team plan" },
      {
        toolContext: {
          currentChannelProvider: "slack",
          currentChannelId: `team:${TEAM_ID}:channel:${CHANNEL_ID}`,
          currentThreadTs: "170000.111",
          replyToMode: "first",
          hasRepliedRef,
        },
      },
    );
    expect(result.details).toMatchObject({ ok: true, channelId: CHANNEL_ID, canvasId: CANVAS_ID });
    expect(requests).toEqual([
      {
        method: "conversations.info",
        args: { channel: CHANNEL_ID, team_id: TEAM_ID },
        authorization: "Bearer xoxb-canvas-test",
      },
      {
        method: "conversations.canvases.create",
        args: {
          channel_id: CHANNEL_ID,
          team_id: TEAM_ID,
          title: "Team plan",
          document_content: JSON.stringify({ type: "markdown", markdown }),
        },
        authorization: "Bearer xoxb-canvas-test",
      },
    ]);
    expect(hasRepliedRef.value).toBe(false);
  });

  it.each([
    { operation: "insert_before", sectionId: "section-1", markdown: "Before" },
    { operation: "insert_after", sectionId: "section-1", markdown: "After" },
    { operation: "insert_at_start", sectionId: undefined, markdown: "First" },
    { operation: "insert_at_end", sectionId: undefined, markdown: "Last" },
    { operation: "replace", sectionId: "section-1", markdown: "Replacement section" },
    { operation: "replace", sectionId: undefined, markdown: "Replacement document" },
    { operation: "delete", sectionId: "section-1", markdown: undefined },
  ])(
    "encodes $operation edits with section=$sectionId",
    async ({ operation, sectionId, markdown }) => {
      const { invoke, requests } = createCanvasFixture();
      const result = await invoke("canvas-edit", {
        ...EDIT,
        canvasOperation: operation,
        canvasSectionId: sectionId,
        canvasMarkdown: markdown,
      });
      expect(result.details).toMatchObject({
        ok: true,
        channelId: CHANNEL_ID,
        canvasId: CANVAS_ID,
      });
      expect(requests.map((request) => request.method)).toEqual([
        "conversations.info",
        "canvases.edit",
      ]);
      expect(requests[1]).toMatchObject({
        authorization: "Bearer xoxb-canvas-test",
        args: { canvas_id: CANVAS_ID, team_id: TEAM_ID },
      });
      const changes = requests[1]?.args.changes;
      if (!changes) {
        throw new Error("Expected an encoded canvas edit request");
      }
      expect(JSON.parse(changes)).toEqual([
        {
          operation,
          ...(sectionId ? { section_id: sectionId } : {}),
          ...(markdown ? { document_content: { type: "markdown", markdown } } : {}),
        },
      ]);
    },
  );

  it("rechecks channel association on every edit and never edits a substituted canvas", async () => {
    const { invoke, requests, state } = createCanvasFixture();
    await invoke("canvas-edit", EDIT);
    state.info = {
      ok: true,
      channel: {
        id: CHANNEL_ID,
        is_channel: true,
        properties: { canvas: { file_id: "F99999999" } },
      },
    };
    await expect(invoke("canvas-edit", EDIT)).rejects.toThrow();
    expect(requests.map((request) => request.method)).toEqual([
      "conversations.info",
      "canvases.edit",
      "conversations.info",
    ]);
  });

  it("refuses to replace an existing channel canvas through creation", async () => {
    const { invoke, requests } = createCanvasFixture();
    await expect(invoke("canvas-create", CREATE)).rejects.toThrow(
      `already has canvas ${CANVAS_ID}. Use canvas-edit`,
    );
    expect(requests.map((request) => request.method)).toEqual(["conversations.info"]);
  });

  it("supports a private channel without treating it as a group DM", async () => {
    const { invoke, requests, state } = createCanvasFixture();
    const channelId = "G01234567";
    state.info = { ok: true, channel: { id: channelId, is_group: true, is_mpim: false } };
    await invoke("canvas-create", { ...CREATE, to: `team:${TEAM_ID}:channel:${channelId}` });
    expect(requests.map((request) => request.method)).toEqual([
      "conversations.info",
      "conversations.canvases.create",
    ]);
    expect(requests[1]?.args.channel_id).toBe(channelId);
  });

  it.each([
    { name: "missing metadata", channel: undefined },
    { name: "different channel", channel: { id: "C99999999", is_channel: true } },
    { name: "unclassified channel", channel: { id: CHANNEL_ID } },
    { name: "DM", channel: { id: CHANNEL_ID, is_channel: true, is_im: true } },
    { name: "group DM", channel: { id: CHANNEL_ID, is_group: true, is_mpim: true } },
  ])("rejects $name metadata before mutation", async ({ channel }) => {
    const { invoke, requests, state } = createCanvasFixture();
    state.info = { ok: true, channel };
    await expect(invoke("canvas-create", CREATE)).rejects.toThrow();
    expect(requests.map((request) => request.method)).toEqual(["conversations.info"]);
  });

  it("does not treat a channel without a canvas association as authority to edit a canvas", async () => {
    const { invoke, requests, state } = createCanvasFixture();
    state.info = { ok: true, channel: { id: CHANNEL_ID, is_channel: true } };
    await expect(invoke("canvas-edit", EDIT)).rejects.toThrow();
    expect(requests.map((request) => request.method)).toEqual(["conversations.info"]);
  });

  it.each([
    {
      name: "named allowlist",
      groupPolicy: "allowlist",
      enabled: true,
      channelName: "plans",
      allowed: true,
    },
    {
      name: "renamed channel",
      groupPolicy: "allowlist",
      enabled: true,
      channelName: "other",
      allowed: false,
    },
    {
      name: "named denial",
      groupPolicy: "open",
      enabled: false,
      channelName: "plans",
      allowed: false,
    },
    {
      name: "missing required name",
      groupPolicy: "open",
      enabled: false,
      channelName: undefined,
      allowed: false,
    },
  ] as const)(
    "checks $name with fresh bot metadata",
    async ({ groupPolicy, enabled, channelName, allowed }) => {
      const { cfg, invoke, requests, state } = createCanvasFixture();
      cfg.channels!.slack!.groupPolicy = groupPolicy;
      cfg.channels!.slack!.dangerouslyAllowNameMatching = true;
      cfg.channels!.slack!.channels = { plans: { enabled } };
      state.info = {
        ok: true,
        channel: { id: CHANNEL_ID, is_channel: true, name: channelName },
      };
      const result = invoke("canvas-create", CREATE, { toolContext: undefined });
      if (allowed) {
        await expect(result).resolves.toMatchObject({ details: { ok: true, canvasId: CANVAS_ID } });
      } else {
        await expect(result).rejects.toThrow("not allowed");
      }
      expect(requests.map((request) => request.method)).toEqual(
        allowed ? ["conversations.info", "conversations.canvases.create"] : ["conversations.info"],
      );
      expect(requests.every((request) => request.authorization === "Bearer xoxb-canvas-test")).toBe(
        true,
      );
    },
  );

  it.each(["canvas-create", "canvas-edit"] as const)(
    "enforces policy and messages gate for %s",
    async (action) => {
      const { adapter, cfg, invoke, requests } = createCanvasFixture();
      const params = action === "canvas-create" ? CREATE : EDIT;
      cfg.channels!.slack!.channels = { [CHANNEL_ID]: { enabled: false } };
      await expect(invoke(action, params)).rejects.toThrow("not allowed");
      cfg.channels!.slack!.channels = undefined;
      cfg.channels!.slack!.actions = { messages: false, canvas: true };
      expect(adapter.describeMessageTool({ cfg, accountId: "default" })?.actions).not.toContain(
        action,
      );
      await expect(invoke(action, params)).rejects.toThrow("Slack messages are disabled");
      expect(requests).toEqual([]);
    },
  );

  it.each(["user identity", "missing bot token"])(
    "hides and rejects canvases with %s",
    async (scenario) => {
      const { adapter, cfg, invoke, requests } = createCanvasFixture();
      if (scenario === "user identity") {
        cfg.channels!.slack!.postAs = "user";
      } else {
        vi.stubEnv("SLACK_BOT_TOKEN", undefined);
        cfg.channels!.slack!.botToken = undefined;
        cfg.channels!.slack!.userTokenReadOnly = false;
      }
      const actions = adapter.describeMessageTool({ cfg, accountId: "default" })?.actions;
      for (const action of ["canvas-create", "canvas-edit"] as const) {
        expect(actions).not.toContain(action);
        await expect(invoke(action, action === "canvas-create" ? CREATE : EDIT)).rejects.toThrow();
      }
      expect(requests).toEqual([]);
    },
  );

  it.each([
    {
      name: "missing markdown",
      action: "canvas-create",
      params: { ...CREATE, canvasMarkdown: undefined },
    },
    {
      name: "blank markdown",
      action: "canvas-create",
      params: { ...CREATE, canvasMarkdown: " \n " },
    },
    {
      name: "nonstring markdown",
      action: "canvas-create",
      params: { ...CREATE, canvasMarkdown: 3 },
    },
    { name: "blank title", action: "canvas-create", params: { ...CREATE, canvasTitle: " " } },
    {
      name: "create with edit fields",
      action: "canvas-create",
      params: { ...CREATE, canvasOperation: "replace" },
    },
    {
      name: "invalid canvas ID",
      action: "canvas-edit",
      params: { ...EDIT, canvasId: "C01234567" },
    },
    { name: "missing canvas ID", action: "canvas-edit", params: { ...EDIT, canvasId: undefined } },
    {
      name: "unknown operation",
      action: "canvas-edit",
      params: { ...EDIT, canvasOperation: "append" },
    },
    {
      name: "missing operation",
      action: "canvas-edit",
      params: { ...EDIT, canvasOperation: undefined },
    },
    {
      name: "missing insert section",
      action: "canvas-edit",
      params: { ...EDIT, canvasOperation: "insert_after" },
    },
    {
      name: "missing delete section",
      action: "canvas-edit",
      params: { ...EDIT, canvasOperation: "delete", canvasMarkdown: undefined },
    },
    {
      name: "unexpected start section",
      action: "canvas-edit",
      params: { ...EDIT, canvasOperation: "insert_at_start", canvasSectionId: "section-1" },
    },
    {
      name: "unexpected end section",
      action: "canvas-edit",
      params: { ...EDIT, canvasSectionId: "section-1" },
    },
    {
      name: "delete content",
      action: "canvas-edit",
      params: { ...EDIT, canvasOperation: "delete", canvasSectionId: "section-1" },
    },
    {
      name: "missing edit content",
      action: "canvas-edit",
      params: { ...EDIT, canvasMarkdown: undefined },
    },
    { name: "edit title", action: "canvas-edit", params: { ...EDIT, canvasTitle: "Rename" } },
  ] satisfies {
    name: string;
    action: ChannelMessageActionName;
    params: Record<string, unknown>;
  }[])("rejects $name before contacting Slack", async ({ action, params }) => {
    const { invoke, requests } = createCanvasFixture();
    await expect(invoke(action, params)).rejects.toThrow();
    expect(requests).toEqual([]);
  });

  it.each([
    ["threadId", "170000.111"],
    ["replyTo", "170000.111"],
    ["threadTs", "170000.111"],
    ["topLevel", false],
    ["replyBroadcast", false],
    ["message", "Not canvas markdown"],
    ["messageId", "170000.111"],
    ["media", "https://example.invalid/image.png"],
    ["presentation", { blocks: [] }],
    ["blocks", []],
  ])("rejects incompatible %s input without silently dropping it", async (field, value) => {
    const { invoke, requests } = createCanvasFixture();
    for (const action of ["canvas-create", "canvas-edit"] as const) {
      await expect(
        invoke(action, {
          ...(action === "canvas-create" ? CREATE : EDIT),
          [field as string]: value,
        }),
      ).rejects.toThrow();
    }
    expect(requests).toEqual([]);
  });

  it.each([
    { name: "detached", overrides: { toolContext: undefined } },
    { name: "cross-account", overrides: { requesterAccountId: "other-account" } },
    {
      name: "conflicting current workspace",
      overrides: {
        toolContext: {
          currentChannelProvider: "slack",
          currentChannelId: `team:${TEAM_ID}:channel:${CHANNEL_ID}`,
          currentMessagingTarget: `team:T22222222:channel:${CHANNEL_ID}`,
        },
      },
    },
  ])(
    "rejects $name Enterprise calls without an explicit target workspace",
    async ({ overrides }) => {
      const { invoke, requests } = createCanvasFixture();
      const installation = registerSlackInstallationState("default", "enterprise");
      try {
        await expect(invoke("canvas-create", CREATE, overrides)).rejects.toThrow(
          "unsupported_enterprise_slack_delivery",
        );
        expect(requests).toEqual([]);
      } finally {
        installation.release();
      }
    },
  );

  it("preserves an explicit Enterprise workspace on detached canvas mutations", async () => {
    const { invoke, requests } = createCanvasFixture();
    const installation = registerSlackInstallationState("default", "enterprise");
    try {
      await invoke(
        "canvas-edit",
        { ...EDIT, to: `team:T22222222:channel:${CHANNEL_ID}` },
        { toolContext: undefined },
      );
      expect(requests.map((request) => request.args.team_id)).toEqual(["T22222222", "T22222222"]);
    } finally {
      installation.release();
    }
  });

  it.each(["metadata", "mutation", "lost response"])(
    "reports %s failures without retrying a mutation",
    async (failure) => {
      const { invoke, requests, state } = createCanvasFixture();
      if (failure === "metadata") {
        state.info = { ok: false, error: "channel_not_found" };
      } else if (failure === "mutation") {
        state.mutation = { ok: false, error: "missing_scope" };
      } else {
        state.failMutationTransport = true;
      }
      await expect(invoke("canvas-edit", EDIT)).rejects.toThrow(
        failure === "metadata"
          ? "channel_not_found"
          : failure === "mutation"
            ? "missing_scope"
            : "response lost",
      );
      expect(requests.map((request) => request.method)).toEqual(
        failure === "metadata" ? ["conversations.info"] : ["conversations.info", "canvases.edit"],
      );
    },
  );

  it.each([undefined, "C01234567"])(
    "reports an unconfirmed create when Slack returns canvas_id=%s",
    async (canvasId) => {
      const { invoke, requests, state } = createCanvasFixture();
      state.info = { ok: true, channel: { id: CHANNEL_ID, is_channel: true } };
      state.mutation = { ok: true, canvas_id: canvasId };
      await expect(invoke("canvas-create", CREATE)).rejects.toThrow("canvas ID");
      expect(requests.map((request) => request.method)).toEqual([
        "conversations.info",
        "conversations.canvases.create",
      ]);
    },
  );
});
