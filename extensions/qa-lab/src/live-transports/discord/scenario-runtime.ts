import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { discordQaScenarioSupport } from "./discord-live.runtime.js";
import type { DiscordQaScenarioEnvironment } from "./scenario-environment.js";

async function runDiscordScenario(environment: DiscordQaScenarioEnvironment, scenarioId: string) {
  const scenario = discordQaScenarioSupport.testing.findScenario([scenarioId])[0];
  if (!scenario) {
    throw new Error(`unknown Discord QA scenario id: ${scenarioId}`);
  }
  const run = scenario.buildRun(environment.runtimeEnv.sutApplicationId);
  if (run.kind === "application-command-registration") {
    const registered =
      await discordQaScenarioSupport.testing.assertDiscordApplicationCommandsRegistered({
        token: environment.runtimeEnv.sutBotToken,
        applicationId: environment.runtimeEnv.sutApplicationId,
        expectedCommandNames: run.expectedCommandNames,
        timeoutMs: scenario.timeoutMs,
      });
    return { details: `native command registered (${registered.commandNames.join(", ")})` };
  }
  if (run.kind === "voice-autojoin") {
    if (!environment.voiceChannel) {
      throw new Error("Discord voice auto-join scenario did not resolve a voice channel.");
    }
    await discordQaScenarioSupport.testing.waitForDiscordVoiceState({
      token: environment.runtimeEnv.sutBotToken,
      guildId: environment.runtimeEnv.guildId,
      channelId: environment.voiceChannel.id,
      sutBotId: environment.sutIdentity.id,
      timeoutMs: scenario.timeoutMs,
    });
    return { details: "SUT bot joined voice channel" };
  }
  if (run.kind === "thread-reply-filepath-attachment") {
    const result =
      await discordQaScenarioSupport.testing.runDiscordThreadReplyFilePathAttachmentScenario({
        cfg: environment.cfg,
        driverBotId: environment.driverIdentity.id,
        outputDir: environment.outputDir,
        runtimeEnv: environment.runtimeEnv,
        scenario,
        scenarioRun: run,
        sutAccountId: environment.sutAccountId,
        sutBotId: environment.sutIdentity.id,
      });
    if (result.status !== "pass") {
      throw new Error(result.details);
    }
    return { details: result.details, artifacts: result.artifactPaths };
  }
  const sent = await discordQaScenarioSupport.testing.sendChannelMessage(
    environment.runtimeEnv.driverBotToken,
    environment.runtimeEnv.channelId,
    run.input,
  );
  if (run.kind === "status-reactions-tool-only") {
    const timeline = await discordQaScenarioSupport.testing.observeStatusReactionTimeline({
      token: environment.runtimeEnv.driverBotToken,
      channelId: environment.runtimeEnv.channelId,
      expectedSequence: run.expectedSequence,
      messageId: sent.id,
      scenarioId: scenario.id,
      scenarioTitle: scenario.title,
      timeoutMs: scenario.timeoutMs,
    });
    const evidence = await discordQaScenarioSupport.testing.writeDiscordStatusReactionEvidence({
      outputDir: environment.outputDir,
      timeline,
    });
    const missing = run.expectedSequence.filter((emoji) => !timeline.seenSequence.includes(emoji));
    if (missing.length > 0) {
      throw new Error(
        `reaction timeline missing ${missing.join(", ")}; saw ${timeline.seenSequence.join(" -> ") || "none"}`,
      );
    }
    return {
      details: `reaction timeline matched ${timeline.seenSequence.join(" -> ")}`,
      artifacts: evidence,
    };
  }
  try {
    const matched = await discordQaScenarioSupport.testing.pollChannelMessages({
      token: environment.runtimeEnv.driverBotToken,
      channelId: environment.runtimeEnv.channelId,
      afterSnowflake: sent.id,
      timeoutMs: scenario.timeoutMs,
      observedMessages: environment.observedMessages,
      observationScenarioId: scenario.id,
      observationScenarioTitle: scenario.title,
      triggerMessageId: sent.id,
      triggerTimestamp: sent.timestamp,
      predicate: (message) =>
        discordQaScenarioSupport.testing.matchesDiscordScenarioReply({
          channelId: environment.runtimeEnv.channelId,
          matchText: run.matchText,
          message,
          sutBotId: environment.sutIdentity.id,
        }),
    });
    if (!run.expectReply) {
      throw new Error(`unexpected reply message ${matched.message.messageId} matched`);
    }
    discordQaScenarioSupport.testing.assertDiscordScenarioReply({
      expectedTextIncludes: run.expectedTextIncludes,
      message: matched.message,
    });
    return { details: "reply matched" };
  } catch (error) {
    if (
      !run.expectReply &&
      formatErrorMessage(error) ===
        `timed out after ${scenario.timeoutMs}ms waiting for Discord message`
    ) {
      return { details: "no reply" };
    }
    throw error;
  }
}

export const runDiscordCanaryScenario = (context: DiscordQaScenarioEnvironment) =>
  runDiscordScenario(context, "discord-canary");
export const runDiscordMentionGatingScenario = (context: DiscordQaScenarioEnvironment) =>
  runDiscordScenario(context, "discord-mention-gating");
export const runDiscordNativeHelpCommandRegistrationScenario = (
  context: DiscordQaScenarioEnvironment,
) => runDiscordScenario(context, "discord-native-help-command-registration");
export const runDiscordVoiceAutojoinScenario = (context: DiscordQaScenarioEnvironment) =>
  runDiscordScenario(context, "discord-voice-autojoin");
export const runDiscordStatusReactionsToolOnlyScenario = (context: DiscordQaScenarioEnvironment) =>
  runDiscordScenario(context, "discord-status-reactions-tool-only");
export const runDiscordThreadReplyFilepathAttachmentScenario = (
  context: DiscordQaScenarioEnvironment,
) => runDiscordScenario(context, "discord-thread-reply-filepath-attachment");
