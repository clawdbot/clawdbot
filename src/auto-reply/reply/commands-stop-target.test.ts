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

const abortEmbeddedPiRunMock = vi.hoisted(() => vi.fn());
const createInternalHookEventMock = vi.hoisted(() => vi.fn(() => ({})));
const persistAbortTargetEntryMock = vi.hoisted(() => vi.fn(async () => true));
const replyRunAbortMock = vi.hoisted(() => vi.fn());
const resolveSessionIdMock = vi.hoisted(() => vi.fn(() => undefined));
const stopSubagentsForRequesterMock = vi.hoisted(() => vi.fn(() => ({ stopped: 0 })));

vi.mock("../../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: abortEmbeddedPiRunMock,
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
  formatAbortReplyText: vi.fn(() => "⚙️ Agent was aborted."),
  isAbortTrigger: vi.fn(() => false),
  resolveSessionEntryForKey: vi.fn(() => ({ entry: undefined, key: undefined })),
  setAbortMemory: vi.fn(),
  stopSubagentsForRequester: stopSubagentsForRequesterMock,
}));

vi.mock("./commands-session-store.js", () => ({
  persistAbortTargetEntry: persistAbortTargetEntryMock,
}));

vi.mock("./reply-run-registry.js", () => ({
  replyRunRegistry: {
    abort: replyRunAbortMock,
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
    expect(replyRunAbortMock).toHaveBeenCalledWith("agent:target:telegram:direct:123");
    expect(abortEmbeddedPiRunMock).not.toHaveBeenCalledWith("wrapper-session-id");
    const [[persistAbortTargetParams]] = persistAbortTargetEntryMock.mock.calls as unknown as Array<
      [
        {
          key?: string;
          entry?: unknown;
          sessionStore?: unknown;
          storePath?: string;
        },
      ]
    >;
    expect(persistAbortTargetParams?.key).toBe("agent:target:telegram:direct:123");
    expect(persistAbortTargetParams?.entry).toBeUndefined();
    expect(persistAbortTargetParams?.sessionStore).toBe(params.sessionStore);
    expect(persistAbortTargetParams?.storePath).toBe("/tmp/sessions.json");
    const [[stopSubagentsParams]] = stopSubagentsForRequesterMock.mock.calls as unknown as Array<
      [{ cfg?: unknown; requesterSessionKey?: string }]
    >;
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
    expect(replyRunAbortMock).not.toHaveBeenCalled();
    expect(persistAbortTargetEntryMock).not.toHaveBeenCalled();
    expect(createInternalHookEventMock).not.toHaveBeenCalled();
    expect(stopSubagentsForRequesterMock).not.toHaveBeenCalled();
  });
});
