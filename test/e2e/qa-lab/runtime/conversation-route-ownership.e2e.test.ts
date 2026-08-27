import { randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it } from "vitest";
import {
  createQaBusState,
  createQaChannelTransport,
  startQaBusServer,
} from "../../../../extensions/qa-lab/api.js";
import { startQaLiveLaneGateway } from "../../../../extensions/qa-lab/runtime-api.js";

const CHANNEL_ID = "qa-channel";
const PRIMARY_AGENT_ID = "main";
const SIBLING_AGENT_ID = "finance";
const PRIMARY_ACCOUNT_ID = "default";
const SIBLING_ACCOUNT_ID = "finance";
const PRIMARY_PEER_ID = "primary-peer";
const SIBLING_PEER_ID = "finance-peer";

type GatewayHarness = Awaited<ReturnType<typeof startQaLiveLaneGateway>>;

let harness: GatewayHarness | undefined;
let bus: Awaited<ReturnType<typeof startQaBusServer>> | undefined;

function conversationItems(payload: unknown): Array<Record<string, unknown>> {
  if (!isRecord(payload) || !Array.isArray(payload.conversations)) {
    throw new Error(`conversations.list returned an invalid payload: ${JSON.stringify(payload)}`);
  }
  const items = payload.conversations.filter(isRecord);
  if (items.length !== payload.conversations.length) {
    throw new Error(`conversations.list returned an invalid item: ${JSON.stringify(payload)}`);
  }
  return items;
}

function findConversation(
  items: Array<Record<string, unknown>>,
  accountId: string,
  targetIncludes: string,
) {
  return items.find(
    (item) =>
      item.accountId === accountId &&
      typeof item.target === "string" &&
      item.target.includes(targetIncludes),
  );
}

async function listConversations(gateway: GatewayHarness["gateway"], agentId: string) {
  return conversationItems(
    await gateway.call("conversations.list", {
      agentId,
      channel: CHANNEL_ID,
      limit: 50,
    }),
  );
}

async function waitForConversation(params: {
  gateway: GatewayHarness["gateway"];
  agentId: string;
  accountId: string;
  targetIncludes: string;
}) {
  const deadline = Date.now() + 30_000;
  let latest: Array<Record<string, unknown>> = [];
  while (Date.now() < deadline) {
    latest = await listConversations(params.gateway, params.agentId);
    const match = findConversation(latest, params.accountId, params.targetIncludes);
    if (match) {
      return match;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `timed out waiting for ${params.agentId} to own ${params.accountId}/${params.targetIncludes}: ${JSON.stringify(latest)}`,
  );
}

async function waitForAppliedConfig(gateway: GatewayHarness["gateway"], hash: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const payload = await gateway.call("config.get", {});
    if (
      isRecord(payload) &&
      payload.hash === hash &&
      payload.appliedConfigHash === payload.configRevisionHash
    ) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Gateway did not apply config revision ${hash}`);
}

function outboundMessagesWithText(
  state: ReturnType<typeof createQaBusState>,
  accountId: string,
  text: string,
) {
  return state
    .getSnapshot()
    .messages.filter(
      (message) =>
        message.direction === "outbound" &&
        message.accountId === accountId &&
        message.text === text,
    );
}

async function sendConversation(params: {
  gateway: GatewayHarness["gateway"];
  agentId: string;
  conversationRef: string;
  message: string;
}) {
  return await params.gateway.call("conversations.send", {
    agentId: params.agentId,
    operationId: randomUUID(),
    conversationRef: params.conversationRef,
    message: params.message,
  });
}

afterEach(async () => {
  const cleanupErrors: unknown[] = [];
  try {
    await harness?.stop();
  } catch (error) {
    cleanupErrors.push(error);
  } finally {
    harness = undefined;
  }
  try {
    await bus?.stop();
  } catch (error) {
    cleanupErrors.push(error);
  } finally {
    bus = undefined;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "conversation route ownership proof cleanup failed");
  }
});

describe("conversation route ownership clean-machine proof", () => {
  it(
    "keeps sibling accounts isolated and revalidates persisted references after reassignment",
    { timeout: 120_000 },
    async () => {
      const state = createQaBusState();
      const transport = createQaChannelTransport(state);
      bus = await startQaBusServer({ state });
      harness = await startQaLiveLaneGateway({
        repoRoot: process.cwd(),
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
        alternateModel: "mock-openai/gpt-5.6-luna-alt",
        transport,
        transportBaseUrl: bus.baseUrl,
        controlUiEnabled: false,
        mockAuthAgentIds: [PRIMARY_AGENT_ID, SIBLING_AGENT_ID],
        mutateConfig: (config) => ({
          ...config,
          agents: {
            ...config.agents,
            ownership: "explicit",
            entries: {
              ...config.agents?.entries,
              [PRIMARY_AGENT_ID]: {},
              [SIBLING_AGENT_ID]: {},
            },
          },
          bindings: [
            {
              type: "route",
              agentId: PRIMARY_AGENT_ID,
              match: { channel: CHANNEL_ID, accountId: PRIMARY_ACCOUNT_ID },
            },
            {
              type: "route",
              agentId: SIBLING_AGENT_ID,
              match: { channel: CHANNEL_ID, accountId: SIBLING_ACCOUNT_ID },
            },
          ],
          channels: {
            ...config.channels,
            [CHANNEL_ID]: {
              ...config.channels?.[CHANNEL_ID],
              accounts: {
                [SIBLING_ACCOUNT_ID]: {
                  baseUrl: bus?.baseUrl,
                  enabled: true,
                  allowFrom: ["*"],
                  pollTimeoutMs: 250,
                },
              },
            },
          },
        }),
      });
      const { gateway } = harness;

      state.addInboundMessage({
        accountId: PRIMARY_ACCOUNT_ID,
        conversation: { kind: "direct", id: PRIMARY_PEER_ID },
        senderId: PRIMARY_PEER_ID,
        text: "seed primary ownership",
      });
      state.addInboundMessage({
        accountId: SIBLING_ACCOUNT_ID,
        conversation: { kind: "direct", id: SIBLING_PEER_ID },
        senderId: SIBLING_PEER_ID,
        text: "seed sibling ownership",
      });

      const primaryConversation = await waitForConversation({
        gateway,
        agentId: PRIMARY_AGENT_ID,
        accountId: PRIMARY_ACCOUNT_ID,
        targetIncludes: PRIMARY_PEER_ID,
      });
      const siblingConversation = await waitForConversation({
        gateway,
        agentId: SIBLING_AGENT_ID,
        accountId: SIBLING_ACCOUNT_ID,
        targetIncludes: SIBLING_PEER_ID,
      });
      const primaryList = await listConversations(gateway, PRIMARY_AGENT_ID);
      const siblingList = await listConversations(gateway, SIBLING_AGENT_ID);
      expect(findConversation(primaryList, SIBLING_ACCOUNT_ID, SIBLING_PEER_ID)).toBeUndefined();
      expect(findConversation(siblingList, PRIMARY_ACCOUNT_ID, PRIMARY_PEER_ID)).toBeUndefined();

      const primaryConversationRef = String(primaryConversation.conversationRef);
      const siblingConversationRef = String(siblingConversation.conversationRef);
      const initialAllowedText = `ownership-proof-initial-${randomUUID()}`;
      await sendConversation({
        gateway,
        agentId: PRIMARY_AGENT_ID,
        conversationRef: primaryConversationRef,
        message: initialAllowedText,
      });
      expect(outboundMessagesWithText(state, PRIMARY_ACCOUNT_ID, initialAllowedText)).toHaveLength(
        1,
      );

      const configBefore = await gateway.call("config.get", {});
      if (!isRecord(configBefore) || typeof configBefore.hash !== "string") {
        throw new Error(`config.get returned no hash: ${JSON.stringify(configBefore)}`);
      }
      const patchResult = await gateway.call("config.patch", {
        raw: JSON.stringify({
          bindings: [
            {
              type: "route",
              agentId: SIBLING_AGENT_ID,
              match: { channel: CHANNEL_ID, accountId: PRIMARY_ACCOUNT_ID },
            },
            {
              type: "route",
              agentId: SIBLING_AGENT_ID,
              match: { channel: CHANNEL_ID, accountId: SIBLING_ACCOUNT_ID },
            },
          ],
        }),
        baseHash: configBefore.hash,
        replacePaths: ["bindings"],
        restartDelayMs: 0,
      });
      if (!isRecord(patchResult) || typeof patchResult.hash !== "string") {
        throw new Error(`config.patch returned no hash: ${JSON.stringify(patchResult)}`);
      }
      await waitForAppliedConfig(gateway, patchResult.hash);

      const staleSendText = `ownership-proof-stale-send-${randomUUID()}`;
      let staleSendDenied = false;
      try {
        await sendConversation({
          gateway,
          agentId: PRIMARY_AGENT_ID,
          conversationRef: primaryConversationRef,
          message: staleSendText,
        });
      } catch {
        staleSendDenied = true;
      }
      expect(staleSendDenied).toBe(true);
      expect(outboundMessagesWithText(state, PRIMARY_ACCOUNT_ID, staleSendText)).toHaveLength(0);

      const staleTurnText = `ownership-proof-stale-turn-${randomUUID()}`;
      let staleTurnDenied = false;
      try {
        await gateway.call("conversations.turn", {
          agentId: PRIMARY_AGENT_ID,
          turnId: randomUUID(),
          conversationRef: primaryConversationRef,
          message: staleTurnText,
          timeoutMs: 1_000,
        });
      } catch {
        staleTurnDenied = true;
      }
      expect(staleTurnDenied).toBe(true);
      expect(outboundMessagesWithText(state, PRIMARY_ACCOUNT_ID, staleTurnText)).toHaveLength(0);

      const siblingAllowedText = `ownership-proof-sibling-${randomUUID()}`;
      await sendConversation({
        gateway,
        agentId: SIBLING_AGENT_ID,
        conversationRef: siblingConversationRef,
        message: siblingAllowedText,
      });
      expect(outboundMessagesWithText(state, SIBLING_ACCOUNT_ID, siblingAllowedText)).toHaveLength(
        1,
      );

      const verdict = {
        ok: true,
        siblingAccountHiddenFromPrimaryAgent:
          findConversation(primaryList, SIBLING_ACCOUNT_ID, SIBLING_PEER_ID) === undefined,
        primaryAccountHiddenFromSiblingAgent:
          findConversation(siblingList, PRIMARY_ACCOUNT_ID, PRIMARY_PEER_ID) === undefined,
        initialOwnerDeliveredExactlyOnce:
          outboundMessagesWithText(state, PRIMARY_ACCOUNT_ID, initialAllowedText).length === 1,
        staleSendDeniedWithoutProviderIo:
          staleSendDenied &&
          outboundMessagesWithText(state, PRIMARY_ACCOUNT_ID, staleSendText).length === 0,
        staleTurnDeniedWithoutProviderIo:
          staleTurnDenied &&
          outboundMessagesWithText(state, PRIMARY_ACCOUNT_ID, staleTurnText).length === 0,
        siblingOwnerDeliveredExactlyOnce:
          outboundMessagesWithText(state, SIBLING_ACCOUNT_ID, siblingAllowedText).length === 1,
      };
      expect(Object.values(verdict).every(Boolean)).toBe(true);
      console.log(`CONVERSATION_ROUTE_OWNERSHIP_PROOF=${JSON.stringify(verdict)}`);
    },
  );
});
