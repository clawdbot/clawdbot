// Regression: outbound mirror route persistence must commit only after a
// successful send. A failed probe (missing channel credentials) previously
// rewrote the folded main session's durable delivery route and minted a
// conversation identity before the send was attempted.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { jsonResult } from "../../agents/tools/common.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  loadExactSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import {
  normalizeSessionDeliveryState,
  sessionDeliveryOrigin,
} from "../../utils/delivery-context.shared.js";
import { runMessageAction } from "./message-action-runner.js";

vi.mock("../../tts/tts.runtime.js", () => ({
  maybeApplyTtsToPayload: vi.fn(async (params: { payload: unknown }) => params.payload),
}));

const MAIN_SESSION_KEY = "agent:main:main";

describe("outbound mirror route ordering", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let storePath: string;
  let cfg: OpenClawConfig;
  const handleAction = vi.fn();

  function registerTestChannel() {
    const plugin: ChannelPlugin = {
      ...createChannelTestPluginBase({ id: "testchat" }),
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => ({ enabled: true }),
        isConfigured: () => true,
      },
      actions: {
        describeMessageTool: () => ({ actions: ["send"] }),
        supportsAction: ({ action }) => action === "send",
        handleAction,
      },
      outbound: {
        deliveryMode: "direct",
        // The plugin action path above owns the send; core delivery must not run.
        sendText: async () => {
          throw new Error("unexpected core sendText");
        },
      },
    };
    setActivePluginRegistry(createTestRegistry([{ pluginId: "testchat", source: "test", plugin }]));
  }

  async function seedMainSessionWithDiscordOrigin() {
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: MAIN_SESSION_KEY, storePath },
      {
        sessionId: "main-session",
        updatedAt: 100,
        chatType: "direct",
        delivery: normalizeSessionDeliveryState({
          context: { channel: "discord", accountId: "default", to: "user:operator" },
          origin: { provider: "discord", accountId: "default", from: "discord:operator" },
        }),
      },
    );
  }

  function mainSessionOrigin() {
    const persisted = loadExactSessionEntry({
      agentId: "main",
      sessionKey: MAIN_SESSION_KEY,
      storePath,
    });
    return sessionDeliveryOrigin(persisted?.entry);
  }

  beforeEach(async () => {
    storePath = path.join(tempDirs.make("openclaw-mirror-order-"), "sessions.json");
    cfg = {
      session: { store: storePath },
      channels: { testchat: { enabled: true } },
    } as OpenClawConfig;
    handleAction.mockReset();
    registerTestChannel();
    await seedMainSessionWithDiscordOrigin();
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
    closeOpenClawAgentDatabasesForTest();
  });

  it("leaves the main session route untouched when the send fails", async () => {
    handleAction.mockRejectedValue(
      new Error("testchat bot token missing. Set channels.testchat.botToken."),
    );

    await expect(
      runMessageAction({
        cfg,
        action: "send",
        params: { channel: "testchat", to: "user:12345", message: "hi" },
        agentId: "main",
        dryRun: false,
      }),
    ).rejects.toThrow("token missing");

    expect(handleAction).toHaveBeenCalledOnce();
    expect(mainSessionOrigin()).toMatchObject({
      provider: "discord",
      from: "discord:operator",
    });
  });

  it("persists the outbound mirror route after a successful send", async () => {
    handleAction.mockResolvedValue(jsonResult({ ok: true, messageId: "m1" }));

    const result = await runMessageAction({
      cfg,
      action: "send",
      params: { channel: "testchat", to: "user:12345", message: "hi" },
      agentId: "main",
      dryRun: false,
    });

    expect(result.kind).toBe("send");
    expect(mainSessionOrigin()).toMatchObject({
      provider: "testchat",
      from: "testchat:12345",
    });
  });
});
