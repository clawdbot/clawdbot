import type { MoltbotConfig } from "../config/config.js";
import type { MsgContext } from "../auto-reply/templating.js";
import { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
import {
  extractMediaUserText,
  formatAudioTranscripts,
  formatMediaUnderstandingBody,
} from "./format.js";
import type {
  MediaUnderstandingCapability,
  MediaUnderstandingDecision,
  MediaUnderstandingOutput,
  MediaUnderstandingProvider,
} from "./types.js";
import { runWithConcurrency } from "./concurrency.js";
import { resolveConcurrency } from "./resolve.js";
import {
  type ActiveMediaModel,
  buildProviderRegistry,
  createMediaAttachmentCache,
  normalizeMediaAttachments,
  runCapability,
} from "./runner.js";

export type ApplyMediaUnderstandingResult = {
  outputs: MediaUnderstandingOutput[];
  decisions: MediaUnderstandingDecision[];
  appliedImage: boolean;
  appliedAudio: boolean;
  appliedVideo: boolean;
};

const CAPABILITY_ORDER: MediaUnderstandingCapability[] = ["image", "audio", "video"];

export async function applyMediaUnderstanding(params: {
  ctx: MsgContext;
  cfg: MoltbotConfig;
  agentDir?: string;
  providers?: Record<string, MediaUnderstandingProvider>;
  activeModel?: ActiveMediaModel;
}): Promise<ApplyMediaUnderstandingResult> {
  const { ctx, cfg } = params;
  const commandCandidates = [ctx.CommandBody, ctx.RawBody, ctx.Body];
  const originalUserText =
    commandCandidates
      .map((value) => extractMediaUserText(value))
      .find((value) => value && value.trim()) ?? undefined;

  const attachments = normalizeMediaAttachments(ctx);
  const providerRegistry = buildProviderRegistry(params.providers);
  const cache = createMediaAttachmentCache(attachments);

  try {
    const tasks = CAPABILITY_ORDER.map((capability) => async () => {
      const config = cfg.tools?.media?.[capability];
      return await runCapability({
        capability,
        cfg,
        ctx,
        attachments: cache,
        media: attachments,
        agentDir: params.agentDir,
        providerRegistry,
        config,
        activeModel: params.activeModel,
      });
    });

    const results = await runWithConcurrency(tasks, resolveConcurrency(cfg));
    const outputs: MediaUnderstandingOutput[] = [];
    const decisions: MediaUnderstandingDecision[] = [];
    for (const entry of results) {
      if (!entry) continue;
      for (const output of entry.outputs) {
        outputs.push(output);
      }
      decisions.push(entry.decision);
    }

    if (decisions.length > 0) {
      ctx.MediaUnderstandingDecisions = [...(ctx.MediaUnderstandingDecisions ?? []), ...decisions];
    }

    if (outputs.length > 0) {
      ctx.Body = formatMediaUnderstandingBody({ body: ctx.Body, outputs });
      const audioOutputs = outputs.filter((output) => output.kind === "audio.transcription");
      if (audioOutputs.length > 0) {
        const transcript = formatAudioTranscripts(audioOutputs);
        ctx.Transcript = transcript;
        if (originalUserText) {
          ctx.CommandBody = originalUserText;
          ctx.RawBody = originalUserText;
        } else {
          ctx.CommandBody = transcript;
          ctx.RawBody = transcript;
        }
      } else if (originalUserText) {
        ctx.CommandBody = originalUserText;
        ctx.RawBody = originalUserText;
      }
      ctx.MediaUnderstanding = [...(ctx.MediaUnderstanding ?? []), ...outputs];
      finalizeInboundContext(ctx, { forceBodyForAgent: true, forceBodyForCommands: true });
    }

    return {
      outputs,
      decisions,
      appliedImage: outputs.some((output) => output.kind === "image.description"),
      appliedAudio: outputs.some((output) => output.kind === "audio.transcription"),
      appliedVideo: outputs.some((output) => output.kind === "video.description"),
    };
  } finally {
    await cache.cleanup();
  }
}
