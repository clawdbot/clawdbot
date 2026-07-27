// Tests stop command target resolution across active sessions and channel routes.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { resolveCommandAuthorization } from "../command-auth.js";
import type { MsgContext } from "../templating.js";
import { handleStopCommand } from "./commands-session-abort.js";
import "./commands-session-abort.test-support.js";
import type { HandleCommandsParams } from "./commands-types.js";

const abortEmbeddedAgentRunMock = vi.hoisted(() => vi.fn());
const createInternalHookEventMock = vi.hoisted(() => vi.fn(() => ({})));
const persistAbortTargetEntryMock = vi.hoisted(() => vi.fn(async () => true));
const resolveCommandSessionEntryForKeyMock = vi.hoisted(() =>
  vi.fn(() => ({ entry: undefined, key: undefined })),
);
const resolveSessionIdMock = vi.hoisted(() => vi.fn(() => undefined));
const stopSubagentsForRequesterMock = vi.hoisted(() => vi.fn(() => ({ stopped: 0 })));
const abortSessionRunTargetWithOutcomeMock = vi.hoisted(() =>
  vi.fn(() => ({ active: false, aborted: false })),
);
const formatAbortReplyTextMock = vi.hoisted(() => vi.fn(() => "⚙️ Agent was aborted."));

vi.mock("../../agents/embedded-agent.js", () => ({
  abortEmbeddedAgentRun: abortEmbeddedAgentRunMock,
}));

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("../../hooks/internal-hooks.js", () => ({
  createInternalHookEvent: createInternalHookEventMock,
  triggerInternalHook: vi.fn(async () => undefined),
}));

vi.mock("./abort-cutoff.js", () => ({
  resolveAbortCutoffFromContext: vi.fn(() => undefined),
  shouldPersistAbortCutoff: vi.fn(() => false),
}));

vi.mock("./abort.js", () => ({
  abortSessionRunTargetWithOutcome: abortSessionRunTargetWithOutcomeMock,
  formatAbortReplyText: formatAbortReplyTextMock,
  isAbortTrigger: vi.fn(() => false),
  setAbortMemory: vi.fn(),
  stopSubagentsForRequester: stopSubagentsForRequesterMock,
}));

vi.mock("./commands-session-store.js", () => ({
  persistAbortTargetEntry: persistAbortTargetEntryMock,
  resolveCommandSessionEntryForKey: resolveCommandSessionEntryForKeyMock,
}));

vi.mock("./reply-run-registry.js", () => ({
  replyRunRegistry: {
    resolveSessionId: resolveSessionIdMock,
  },
}));

const formatAllowFrom = ({ allowFrom }: { allowFrom: Array<string | number> }) => {
  const values: string[] = [];
  for (const entry of allowFrom) {
    const value = String(entry).trim();
    if (value) {
      values.push(value);
    }
  }
  return values;
};

let previousPluginRegistry: ReturnType<typeof getActivePluginRegistry>;

function registerOwnerEnforcingTelegramPlugin() {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "telegram",
        plugin: {
          ...createOutboundTestPlugin({
            id: "telegram",
            outbound: { deliveryMode: "direct" },
          }),
          commands: { enforceOwnerForCommands: true },
          config: {
            listAccountIds: () => ["default"],
            resolveAccount: () => ({}),
            resolveAllowFrom: () => ["*"],
            formatAllowFrom,
          },
        },
        source: "test",
      },
    ]),
  );
}

function buildStopParams(): HandleCommandsParams {
  return {
    cfg: {
      commands: { text: true },
      channels: { telegram: { allowFrom: ["*"] } },
    } as OpenClawConfig,
    ctx: {
      Provider: "telegram",
      Surface: "telegram",
      CommandSource: "text",
      CommandTargetSessionKey: "agent:target:telegram:direct:123",
    },
    command: {
      commandBodyNormalized: "/stop",
      rawBodyNormalized: "/stop",
      isAuthorizedSender: true,
      senderIsOwner: true,
      senderId: "owner",
      channel: "telegram",
      channelId: "telegram",
      surface: "telegram",
      ownerList: [],
      from: "owner",
      to: "bot",
    },
    sessionKey: "agent:main:telegram:slash-session",
    sessionEntry: {
      sessionId: "wrapper-session-id",
      updatedAt: Date.now(),
    },
    sessionStore: {},
    storePath: "/tmp/sessions.json",
  } as unknown as HandleCommandsParams;
}

describe("handleStopCommand target fallback", () => {
  beforeEach(() => {
    previousPluginRegistry = getActivePluginRegistry();
    vi.clearAllMocks();
    abortSessionRunTargetWithOutcomeMock.mockReturnValue({ active: false, aborted: false });
    persistAbortTargetEntryMock.mockResolvedValue(true);
  });

  afterEach(() => {
    if (previousPluginRegistry) {
      setActivePluginRegistry(previousPluginRegistry);
    } else {
      resetPluginRuntimeStateForTest();
    }
  });

  it("does not fall back to the wrapper session when a distinct target session is missing from store", async () => {
    const params = buildStopParams();

    const result = await handleStopCommand(params, true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "⚙️ Agent was aborted." },
    });
    expect(abortSessionRunTargetWithOutcomeMock).toHaveBeenCalledWith({
      key: "agent:target:telegram:direct:123",
      sessionId: undefined,
    });
    expect(abortEmbeddedAgentRunMock).not.toHaveBeenCalledWith("wrapper-session-id");
    const [persistAbortTargetParams] = expectDefined(
      (
        persistAbortTargetEntryMock.mock.calls as unknown as Array<
          [
            {
              key?: string;
              entry?: unknown;
              sessionStore?: unknown;
              storePath?: string;
            },
          ]
        >
      )[0],
      "(persistAbortTargetEntryMock.mock.calls as unknown as Array<\n        [\n          {\n            key?: string;\n            entry?: unknown;\n            sessionStore?: unknown;\n            storePath?: string;\n          },\n        ]\n      >)[0] test invariant",
    );
    expect(persistAbortTargetParams?.key).toBe("agent:target:telegram:direct:123");
    expect(persistAbortTargetParams?.entry).toBeUndefined();
    expect(persistAbortTargetParams?.sessionStore).toBe(params.sessionStore);
    expect(persistAbortTargetParams?.storePath).toBe("/tmp/sessions.json");
    const [stopSubagentsParams] = expectDefined(
      (
        stopSubagentsForRequesterMock.mock.calls as unknown as Array<
          [{ cfg?: unknown; requesterSessionKey?: string }]
        >
      )[0],
      "(stopSubagentsForRequesterMock.mock.calls as unknown as Array<\n        [{ cfg?: unknown; requesterSessionKey?: string }]\n      >)[0] test invariant",
    );
    expect(stopSubagentsParams?.cfg).toBe(params.cfg);
    expect(stopSubagentsParams?.requesterSessionKey).toBe("agent:target:telegram:direct:123");
    expect(createInternalHookEventMock).toHaveBeenCalledWith(
      "command",
      "stop",
      "agent:target:telegram:direct:123",
      {
        sessionEntry: undefined,
        sessionId: undefined,
        commandSource: "telegram",
        senderId: "owner",
      },
    );
  });

  it("reports a finalizing target without persisting abort state", async () => {
    const params = buildStopParams();
    abortSessionRunTargetWithOutcomeMock.mockReturnValue({ active: true, aborted: false });
    formatAbortReplyTextMock.mockReturnValue(
      "Agent reply is already finalizing and can no longer be aborted.",
    );

    const result = await handleStopCommand(params, true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "Agent reply is already finalizing and can no longer be aborted." },
    });
    expect(formatAbortReplyTextMock).toHaveBeenCalledWith(0, "finalizing");
    expect(persistAbortTargetEntryMock).not.toHaveBeenCalled();
  });

  it("rejects native stop commands from non-owner senders when the plugin enforces owner-only commands", async () => {
    registerOwnerEnforcingTelegramPlugin();
    const params = buildStopParams();
    const cfg = {
      commands: { text: true, allowFrom: { "*": ["*"] } },
      channels: { telegram: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const ctx = {
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "group",
      From: "telegram:999",
      SenderId: "999",
      CommandSource: "native",
      CommandTargetSessionKey: "agent:target:telegram:direct:123",
    } as MsgContext;
    const auth = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });
    params.cfg = cfg;
    params.ctx = ctx;
    params.command.senderId = auth.senderId;
    params.command.senderIsOwner = auth.senderIsOwner;
    params.command.isAuthorizedSender = auth.isAuthorizedSender;
    params.command.from = auth.from;
    params.command.to = auth.to;

    const result = await handleStopCommand(params, true);

    expect(auth.senderIsOwner).toBe(false);
    expect(auth.isAuthorizedSender).toBe(false);
    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "You are not authorized to use this command." },
    });
    expect(abortSessionRunTargetWithOutcomeMock).not.toHaveBeenCalled();
    expect(persistAbortTargetEntryMock).not.toHaveBeenCalled();
    expect(createInternalHookEventMock).not.toHaveBeenCalled();
    expect(stopSubagentsForRequesterMock).not.toHaveBeenCalled();
  });
});
