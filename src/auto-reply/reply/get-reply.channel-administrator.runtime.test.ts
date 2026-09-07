import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestAdmittedRunContext } from "../../agents/admitted-run-context.test-support.js";
import { bindChannelAdministratorAuthority } from "../../agents/cron-creator-authority-context.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { buildChannelInboundEventContext } from "../../channels/inbound-event/context.js";
import { createHostChannelInboundEventContextBuilder } from "../../channels/inbound-event/host-context-builder.js";
import { registerChannelIngressHostOwner } from "../../channels/message-access/ingress-host-owner.js";
import { resolveStableChannelMessageIngress } from "../../channels/message-access/runtime.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../../config/config.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { ChannelAdministratorAuthority } from "../../gateway/channel-administrator-authority.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import {
  createReplyRuntimeMocks,
  createTempHomeHarness,
  installReplyRuntimeMocks,
  makeEmbeddedTextResult,
  makeReplyConfig,
  resetReplyRuntimeMocks,
} from "../reply.test-harness.js";
import { installDiscordRegistryHooks } from "../test-helpers/command-auth-registry-fixture.js";
import type { GetReplyOptions } from "../types.js";
import { loadGetReplyModuleForTest } from "./get-reply.test-loader.js";
import { createModelSelectionStateFixture } from "./model-selection.test-support.js";

vi.mock("./model-selection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./model-selection.js")>()),
  createModelSelectionState: vi.fn<typeof import("./model-selection.js").createModelSelectionState>(
    async (params) => createModelSelectionStateFixture(params),
  ),
}));

const grant = {
  channel: "discord" as const,
  accountId: "operations",
  senderId: "123456789012345678",
  conversationId: "234567890123456789",
};
const sessionKey = `agent:main:discord:channel:${grant.conversationId}`;
const runId = "trusted-discord-admin-runtime";
const cleanups: Array<() => void> = [];
const agentMocks = createReplyRuntimeMocks();
const { withTempHome } = createTempHomeHarness({ prefix: "openclaw-getreply-channel-admin-" });
let getReplyFromConfig: typeof import("./get-reply.js").getReplyFromConfig;

installReplyRuntimeMocks(agentMocks);
installDiscordRegistryHooks();

async function bindAsAdmittedAgentRun(): Promise<ChannelAdministratorAuthority | undefined> {
  // The final agent mock substitutes for the engine, which normally owns this caller context.
  const { operationalRunInstance } = createTestAdmittedRunContext(runId);
  const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  try {
    return await withGatewayToolCallerIdentity(
      { agentId: "main", sessionKey, operationalRunInstance, approvalAuthority: authority },
      () => bindChannelAdministratorAuthority(runId),
    );
  } finally {
    releaseAgentRunDelegatedAuthority(authority);
  }
}

function makeAdministratorReplyConfig(home: string): OpenClawConfig {
  const config: OpenClawConfig = makeReplyConfig(home);
  config.commands = {
    ownerAllowFrom: [`discord:${grant.senderId}`],
    channelAdministrators: [grant],
  };
  return config;
}

async function buildNativeContext(roomEvent = false) {
  const owner = {
    channelId: grant.channel,
    record: {},
    epoch: {},
    isLive: () => true,
  };
  cleanups.push(registerChannelIngressHostOwner(owner));
  const inboundEventKind = roomEvent ? ("room_event" as const) : ("user_request" as const);
  const channelIngress = await resolveStableChannelMessageIngress({
    channelId: grant.channel,
    accountId: grant.accountId,
    subject: { stableId: grant.senderId },
    conversation: { kind: "channel", id: grant.conversationId },
    contextBinding: {
      agentId: "main",
      sessionKey,
      messageId: "345678901234567890",
      inboundEventKind,
      nativeHumanSource: { senderId: grant.senderId, conversationId: grant.conversationId },
    },
    dmPolicy: "allowlist",
    groupPolicy: "open",
    allowFrom: [],
  });
  const buildContext = createHostChannelInboundEventContextBuilder(
    buildChannelInboundEventContext,
    owner,
  );
  return await buildContext({
    channel: grant.channel,
    accountId: grant.accountId,
    messageId: "345678901234567890",
    from: `discord:channel:${grant.conversationId}`,
    sender: { id: grant.senderId },
    conversation: { kind: "channel", id: grant.conversationId },
    route: { agentId: "main", routeSessionKey: sessionKey },
    reply: { to: `channel:${grant.conversationId}` },
    message: { rawBody: "Update the automation.", inboundEventKind },
    channelIngress,
  });
}

describe("getReplyFromConfig trusted channel administrator admission", () => {
  beforeAll(async () => {
    ({ getReplyFromConfig } = await loadGetReplyModuleForTest({ cacheKey: import.meta.url }));
  });

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    resetReplyRuntimeMocks(agentMocks);
  });

  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      cleanup();
    }
    clearRuntimeConfigSnapshot();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("admits only the fresh authenticated owner turn and does not reuse authority on replay", async () => {
    await withTempHome(async (home) => {
      const config = makeAdministratorReplyConfig(home);
      setRuntimeConfigSnapshot(config);
      const context = await buildNativeContext();
      const seen: Array<ChannelAdministratorAuthority | undefined> = [];
      agentMocks.runEmbeddedAgent.mockImplementation(async () => {
        seen.push(await bindAsAdmittedAgentRun());
        return makeEmbeddedTextResult("ok");
      });

      const reply = await getReplyFromConfig(context, { runId }, config);

      expect(Array.isArray(reply) ? reply[0]?.text : reply?.text).toBe("ok");
      expect(seen).toHaveLength(1);
      expect(seen[0]).toEqual({ runId });
      expect(bindChannelAdministratorAuthority(runId)).toBeUndefined();

      await getReplyFromConfig(context, { runId }, config);

      expect(seen).toHaveLength(2);
      expect(seen[1]).toBeUndefined();
    });
  });

  it.each(["plain context", "no grant", "nonowner"] as const)(
    "keeps normal replies working without administrator authority: %s",
    async (scenario) => {
      await withTempHome(async (home) => {
        const config = makeAdministratorReplyConfig(home);
        if (scenario === "no grant") {
          config.commands!.channelAdministrators = undefined;
        } else if (scenario === "nonowner") {
          config.commands!.ownerAllowFrom = ["discord:456789012345678901"];
        }
        setRuntimeConfigSnapshot(config);
        const nativeContext = await buildNativeContext();
        const context = scenario === "plain context" ? { ...nativeContext } : nativeContext;
        agentMocks.runEmbeddedAgent.mockImplementation(async () => {
          expect(await bindAsAdmittedAgentRun()).toBeUndefined();
          return makeEmbeddedTextResult("ordinary reply");
        });

        const reply = await getReplyFromConfig(context, { runId }, config);

        expect(agentMocks.runEmbeddedAgent).toHaveBeenCalledOnce();
        expect(Array.isArray(reply) ? reply[0]?.text : reply?.text).toBe("ordinary reply");
      });
    },
  );

  it.each([
    "heartbeat",
    "room event",
    "inter-session forwarding",
    "internal continuation",
    "queued replay",
    "spawned session",
  ] as const)("does not elevate a %s carrying owner routing", async (scenario) => {
    await withTempHome(async (home) => {
      const config = makeAdministratorReplyConfig(home);
      setRuntimeConfigSnapshot(config);
      const context = await buildNativeContext(scenario === "room event");
      const options: GetReplyOptions = { runId };
      if (scenario === "heartbeat") {
        options.isHeartbeat = true;
      } else if (scenario === "inter-session forwarding") {
        context.InputProvenance = { kind: "inter_session", sourceTool: "sessions_send" };
      } else if (scenario === "internal continuation") {
        context.InputProvenance = { kind: "internal_system" };
      } else if (scenario === "queued replay") {
        options.suppressNextUserMessagePersistence = true;
      } else if (scenario === "spawned session") {
        await replaceSessionEntry(
          { storePath: config.session!.store!, sessionKey },
          {
            sessionId: "spawned-admin-boundary-test",
            updatedAt: Date.now(),
            spawnedBy: "agent:main:main",
          },
        );
      }
      agentMocks.runEmbeddedAgent.mockImplementation(async () => {
        expect(await bindAsAdmittedAgentRun()).toBeUndefined();
        return makeEmbeddedTextResult("ordinary reply");
      });

      await getReplyFromConfig(context, options, config);

      expect(agentMocks.runEmbeddedAgent).toHaveBeenCalledOnce();
    });
  });
});
