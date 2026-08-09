import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { QaRunnerCliRegistration } from "openclaw/plugin-sdk/qa-runner-runtime";
import {
  acquireQaCredentialLease,
  startQaCredentialLeaseHeartbeat,
} from "../shared/credential-lease.runtime.js";
import { discordQaScenarioSupport } from "./discord-live.runtime.js";
import { createDiscordQaScenarioEnvironment } from "./scenario-environment.js";

type AdapterFactory = NonNullable<QaRunnerCliRegistration["adapterFactory"]>;
type FactoryContext = Parameters<AdapterFactory["create"]>[0];
type AdapterDefinition = Awaited<ReturnType<AdapterFactory["create"]>>;

function discordSnowflakeForTimestamp(timestampMs: number) {
  // Seed the cursor at adapter startup so old channel history is not replayed into the QA bus.
  return (BigInt(timestampMs - 1_420_070_400_000) << 22n).toString();
}

export async function createDiscordQaTransportAdapter(
  context: FactoryContext,
): Promise<AdapterDefinition> {
  const options = context.adapterOptions ?? {};
  const lease = await acquireQaCredentialLease({
    kind: "discord",
    source: options.credentialSource,
    role: options.credentialRole,
    resolveEnvPayload: () => discordQaScenarioSupport.testing.resolveDiscordQaRuntimeEnv(),
    parsePayload: discordQaScenarioSupport.testing.parseDiscordQaCredentialPayload,
  });
  const heartbeat = startQaCredentialLeaseHeartbeat(lease);
  const runtimeEnv = lease.payload;
  let driverIdentity: Awaited<
    ReturnType<typeof discordQaScenarioSupport.testing.getCurrentDiscordUser>
  >;
  let sutIdentity: Awaited<
    ReturnType<typeof discordQaScenarioSupport.testing.getCurrentDiscordUser>
  >;
  try {
    [driverIdentity, sutIdentity] = await Promise.all([
      discordQaScenarioSupport.testing.getCurrentDiscordUser(runtimeEnv.driverBotToken),
      discordQaScenarioSupport.testing.getCurrentDiscordUser(runtimeEnv.sutBotToken),
    ]);
    if (driverIdentity.id === sutIdentity.id) {
      throw new Error("Discord QA requires two distinct bots for driver and SUT.");
    }
    if (sutIdentity.id !== runtimeEnv.sutApplicationId) {
      throw new Error("Discord QA SUT application id must match the SUT bot user id.");
    }
  } catch (error) {
    try {
      await heartbeat.stop();
    } finally {
      await lease.release();
    }
    throw error;
  }
  const accountId = options.sutAccountId?.trim() || "sut";
  let stopped = false;
  let pollingError: Error | undefined;
  let afterSnowflake = discordSnowflakeForTimestamp(Date.now());
  const polling = (async () => {
    for (;;) {
      if (stopped) {
        return;
      }
      try {
        const observed: Parameters<
          typeof discordQaScenarioSupport.testing.pollChannelMessages
        >[0]["observedMessages"] = [];
        const matched = await discordQaScenarioSupport.testing.pollChannelMessages({
          token: runtimeEnv.driverBotToken,
          channelId: runtimeEnv.channelId,
          afterSnowflake,
          timeoutMs: 1_500,
          observedMessages: observed,
          observationScenarioId: "adapter",
          observationScenarioTitle: "Discord adapter",
          predicate: (message: { senderId: string }) => message.senderId === sutIdentity.id,
        });
        afterSnowflake = matched.afterSnowflake;
        await context.messages.addOutboundMessage({
          accountId,
          to: `channel:${runtimeEnv.channelId}`,
          senderId: sutIdentity.id,
          text: matched.message.text,
          timestamp: matched.message.timestamp ? Date.parse(matched.message.timestamp) : Date.now(),
        });
      } catch (error) {
        if (!String(error).includes("timed out after")) {
          throw error;
        }
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 250);
      });
    }
  })().catch((error: unknown) => {
    if (!stopped) {
      pollingError = error instanceof Error ? error : new Error(String(error));
    }
  });
  const scenarioEnvironment = createDiscordQaScenarioEnvironment({
    accountId,
    driverIdentity,
    runtimeEnv,
    sutIdentity,
  });
  return {
    id: "discord",
    label: "Discord live",
    accountId,
    requiredPluginIds: ["discord"],
    supportedActions: [],
    assertTransportHealthy() {
      if (pollingError) {
        throw pollingError;
      }
      heartbeat.throwIfFailed();
    },
    async sendInbound(input) {
      const text = input.text.replaceAll("@openclaw", `<@${runtimeEnv.sutApplicationId}>`);
      const sent = await discordQaScenarioSupport.testing.sendChannelMessage(
        runtimeEnv.driverBotToken,
        runtimeEnv.channelId,
        text,
      );
      afterSnowflake = sent.id;
      return await context.messages.addInboundMessage({
        ...input,
        accountId,
        senderId: driverIdentity.id,
      });
    },
    resetTransport: () => undefined,
    createGatewayConfig: () =>
      discordQaScenarioSupport.testing.buildDiscordQaConfig({} as OpenClawConfig, {
        guildId: runtimeEnv.guildId,
        channelId: runtimeEnv.channelId,
        driverBotId: driverIdentity.id,
        sutAccountId: accountId,
        sutBotToken: runtimeEnv.sutBotToken,
      }),
    prepareFlow: scenarioEnvironment.prepareFlow,
    waitReady: async ({ gateway }) =>
      await discordQaScenarioSupport.testing.waitForDiscordChannelRunning(
        gateway as never,
        accountId,
      ),
    buildAgentDelivery: () => ({
      channel: "discord",
      to: `channel:${runtimeEnv.channelId}`,
      replyChannel: "discord",
      replyTo: `channel:${runtimeEnv.channelId}`,
    }),
    async handleAction() {
      throw new Error("Discord live QA adapter does not implement transport actions");
    },
    createReportNotes: () => ["Uses the Discord live adapter."],
    async cleanup() {
      stopped = true;
      await polling.catch(() => undefined);
      // Lease release must still run when heartbeat shutdown reports an error.
      try {
        await heartbeat.stop();
      } finally {
        await lease.release();
      }
    },
  };
}
