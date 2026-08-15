import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  discordQaScenarioSupport,
  type DiscordQaScenarioImplementation,
} from "./discord-live.runtime.js";
import { runDiscordTranscriptsVoiceAuthorizationScenario } from "./discord-transcripts-authorization.runtime.js";
import type { DiscordQaScenarioEnvironment } from "./scenario-environment.js";

export {
  discordQaCanaryScenario,
  discordQaMentionGatingScenario,
  discordQaNativeHelpCommandRegistrationScenario,
  discordQaStatusReactionsToolOnlyScenario,
  discordQaThreadReplyFilepathAttachmentScenario,
  discordQaVoiceAutojoinScenario,
} from "./discord-live.runtime.js";
export { discordQaTranscriptsVoiceAuthorizationScenario } from "./discord-transcripts-authorization.runtime.js";

export async function runDiscordScenario(
  environment: DiscordQaScenarioEnvironment,
  implementation: DiscordQaScenarioImplementation,
) {
  const scenario = environment.scenario;
  const { cfg, configureTranscriptVoiceAccess, run, voiceChannel } =
    await environment.configureScenario(implementation);
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
    if (!voiceChannel) {
      throw new Error("Discord voice auto-join scenario did not resolve a voice channel.");
    }
    await discordQaScenarioSupport.testing.waitForDiscordVoiceState({
      token: environment.runtimeEnv.sutBotToken,
      guildId: environment.runtimeEnv.guildId,
      channelId: voiceChannel.id,
      sutBotId: environment.sutIdentity.id,
      timeoutMs: scenario.timeoutMs,
    });
    return { details: "SUT bot joined voice channel" };
  }
  if (run.kind === "transcripts-voice-authorization") {
    return await runDiscordTranscriptsVoiceAuthorizationScenario(environment, {
      cfg,
      run,
      voiceChannel,
      configureTranscriptVoiceAccess,
    });
  }
  if (run.kind === "thread-reply-filepath-attachment") {
    const result =
      await discordQaScenarioSupport.testing.runDiscordThreadReplyFilePathAttachmentScenario({
        cfg,
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
