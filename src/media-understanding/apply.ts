// Applies media-understanding outputs to inbound message context, including
// attachment normalization, provider execution, file text extraction, and echoing.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import pMap from "p-map";
import type { ActiveMediaModel } from "../../packages/media-understanding-common/src/active-model.js";
import {
  formatAudioTranscripts,
  formatMediaUnderstandingBody,
} from "../../packages/media-understanding-common/src/format.js";
import { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import { runMediaCapability } from "./apply-capability.js";
import { resolveAttachmentKind } from "./attachments.js";
import { DEFAULT_ECHO_TRANSCRIPT_FORMAT, sendTranscriptEcho } from "./echo-transcript.js";
import type { ExtractedFileImage } from "./extracted-file-images.js";
import { extractFileContext, type LocalPathSelfServeUpgrade } from "./file-context.js";
import { resolveFileExtractionLimits } from "./file-extraction-limits.js";
import {
  applyAttachmentMarkerBudget,
  type AttachmentContextBlock,
  renderMediaAttachmentDisposition,
} from "./media-attachment-outcomes.js";
import { resolveConcurrency } from "./resolve.js";
import {
  buildProviderRegistry,
  createMediaAttachmentCache,
  normalizeMediaAttachments,
  resolveMediaAttachmentLocalRoots,
} from "./runner.js";
import type {
  MediaAttachment,
  MediaUnderstandingCapability,
  MediaUnderstandingDecision,
  MediaUnderstandingOutput,
  MediaUnderstandingProvider,
} from "./types.js";

export type ApplyMediaUnderstandingResult = {
  outputs: MediaUnderstandingOutput[];
  decisions: MediaUnderstandingDecision[];
  extractedFileImages: ExtractedFileImage[];
  appliedImage: boolean;
  appliedAudio: boolean;
  appliedVideo: boolean;
  appliedFile: boolean;
  enableLocalPathSelfServe?: (
    contexts: MsgContext[],
    stagedPaths?: ReadonlyMap<number, string>,
  ) => void;
};

const CAPABILITY_ORDER: MediaUnderstandingCapability[] = ["image", "audio", "video"];
const AUDIO_ONLY_CAPABILITY_ORDER: MediaUnderstandingCapability[] = ["audio"];
const EMPTY_VOICE_NOTE_PLACEHOLDER =
  "[Voice note could not be transcribed because the audio attachment was too small]";

function appendFileBlocks(body: string | undefined, blocks: string[]): string {
  if (!blocks || blocks.length === 0) {
    return body ?? "";
  }
  const base = typeof body === "string" ? body.trim() : "";
  const suffix = blocks.join("\n\n").trim();
  if (!base) {
    return suffix;
  }
  return `${base}\n\n${suffix}`.trim();
}

const SELF_SERVE_CONTEXT_FIELDS = ["Body", "BodyForAgent", "agentText"] as const;

function enableLocalPathSelfServe(
  upgrades: LocalPathSelfServeUpgrade[],
  contexts: MsgContext[],
  stagedPaths?: ReadonlyMap<number, string>,
): void {
  for (const context of contexts) {
    for (const upgrade of upgrades) {
      const stagedPath = stagedPaths?.get(upgrade.attachmentIndex);
      if (stagedPaths && !stagedPath) {
        continue;
      }
      const selfServe = upgrade.render(stagedPath);
      if (!selfServe) {
        continue;
      }
      for (const field of SELF_SERVE_CONTEXT_FIELDS) {
        const value = context[field];
        if (typeof value === "string") {
          context[field] = value.replace(upgrade.fallback, selfServe);
        }
      }
    }
  }
}

function renderMediaAttachmentMarkers(params: {
  attachments: MediaAttachment[];
  decisions: MediaUnderstandingDecision[];
  outputs: MediaUnderstandingOutput[];
  deliveredImageIndexes?: ReadonlySet<number>;
}): AttachmentContextBlock[] {
  const handledIndexes = new Set(params.outputs.map((output) => output.attachmentIndex));
  const decisions = new Map(params.decisions.map((decision) => [decision.capability, decision]));
  return params.attachments.flatMap((attachment) => {
    const capability = resolveAttachmentKind(attachment);
    if (capability !== "image" && capability !== "audio" && capability !== "video") {
      return [];
    }
    // The ACP caller resolved these exact indexes into native turn attachments;
    // a marker would falsely claim non-delivery. Unresolved images keep theirs.
    if (capability === "image" && params.deliveredImageIndexes?.has(attachment.index)) {
      return [];
    }
    const decision = decisions.get(capability);
    if (!decision || handledIndexes.has(attachment.index)) {
      return [];
    }
    const disposition = decision.attachmentDispositions?.[attachment.index];
    // Vision-capable model → the reply runtime hydrates images natively; an
    // absence-of-processing marker would contradict what the model sees.
    // Recorded per-attachment failures stay visible — they are authoritative
    // regardless of native delivery. Partial/failed native hydration remains
    // unexplainable at this frozen-prompt stage (#122101).
    if (
      capability === "image" &&
      decision.nativeVisionActive !== false &&
      disposition?.kind !== "failed"
    ) {
      return [];
    }
    const text = disposition ? renderMediaAttachmentDisposition(capability, disposition) : null;
    return text ? [{ text, consumesMarkerBudget: true }] : [];
  });
}

export async function applyMediaUnderstanding(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  providers?: Record<string, MediaUnderstandingProvider>;
  activeModel?: ActiveMediaModel;
  /** Preserve native-harness ownership of image, video, and file inputs while applying STT. */
  processingMode?: "audio-only";
  /** Render local paths immediately only when the caller owns the final tool surface. */
  selfServeLocalPaths?: boolean;
  /** Attachment indexes the caller (ACP) has already resolved into native turn attachments. */
  deliveredImageIndexes?: ReadonlySet<number>;
}): Promise<ApplyMediaUnderstandingResult> {
  const { ctx, cfg } = params;
  const commandCandidates = [ctx.CommandBody, ctx.RawBody, ctx.Body];
  const originalUserText =
    commandCandidates
      .map((value) => normalizeOptionalString(value))
      .find((value) => value && value.trim()) ?? undefined;

  const attachments = normalizeMediaAttachments(ctx);
  const providerRegistry = buildProviderRegistry(params.providers, cfg);
  const cache = createMediaAttachmentCache(attachments, {
    localPathRoots: resolveMediaAttachmentLocalRoots({
      cfg,
      ctx,
      workspaceDir: params.workspaceDir,
    }),
    ssrfPolicy: cfg.tools?.web?.fetch?.ssrfPolicy,
    workspaceDir: params.workspaceDir,
  });

  try {
    const results = await pMap(
      params.processingMode === "audio-only" ? AUDIO_ONLY_CAPABILITY_ORDER : CAPABILITY_ORDER,
      async (capability) =>
        await runMediaCapability({
          capability,
          cfg,
          ctx,
          attachments: cache,
          media: attachments,
          agentId: params.agentId,
          agentDir: params.agentDir,
          workspaceDir: params.workspaceDir,
          providerRegistry,
          config: cfg.tools?.media?.[capability],
          activeModel: params.activeModel,
        }),
      { concurrency: resolveConcurrency(cfg), stopOnError: false },
    );
    const outputs: MediaUnderstandingOutput[] = [];
    const decisions: MediaUnderstandingDecision[] = [];
    const audioAttachmentIndexes = new Set<number>();
    for (const entry of results) {
      decisions.push(entry.decision);
      if (entry.decision.capability !== "audio") {
        for (const output of entry.outputs) {
          outputs.push(output);
        }
        continue;
      }
      const audioOutputsByAttachmentIndex = new Map<number, MediaUnderstandingOutput>();
      for (const output of entry.outputs) {
        audioOutputsByAttachmentIndex.set(output.attachmentIndex, output);
        audioAttachmentIndexes.add(output.attachmentIndex);
      }
      // Capability results retain image/audio/video order. Project audio in the
      // runner's selected order so placeholders honor attachments.prefer and
      // stay before video even when every audio attachment was too small.
      for (const attachment of entry.decision.attachments) {
        const output = audioOutputsByAttachmentIndex.get(attachment.attachmentIndex);
        if (output) {
          outputs.push(output);
        } else if (
          attachment.attempts.some((attempt) => attempt.reason?.trim().startsWith("tooSmall"))
        ) {
          outputs.push({
            kind: "audio.transcription",
            attachmentIndex: attachment.attachmentIndex,
            text: EMPTY_VOICE_NOTE_PLACEHOLDER,
            provider: "openclaw",
            model: "synthetic-empty-audio",
          });
        }
      }
    }

    if (decisions.length > 0) {
      ctx.MediaUnderstandingDecisions = [...(ctx.MediaUnderstandingDecisions ?? []), ...decisions];
    }

    if (outputs.length > 0) {
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
        // Echo transcript back to chat before agent processing, if configured.
        const audioCfg = cfg.tools?.media?.audio;
        if (audioCfg?.echoTranscript && transcript) {
          await sendTranscriptEcho({
            ctx,
            cfg,
            transcript,
            format: audioCfg.echoFormat ?? DEFAULT_ECHO_TRANSCRIPT_FORMAT,
          });
        }
      } else if (originalUserText) {
        ctx.CommandBody = originalUserText;
        ctx.RawBody = originalUserText;
      }
      ctx.MediaUnderstanding = [...(ctx.MediaUnderstanding ?? []), ...outputs];
    }
    // Only skip file extraction for attachments that have a real (non-synthetic)
    // audio transcription. Synthetic placeholders should not prevent file extraction
    // for tiny audio-MIME files that could be recovered as text via forcedTextMime.
    const fileContext =
      params.processingMode === "audio-only"
        ? { blocks: [], images: [], localPathSelfServeUpgrades: [] }
        : await extractFileContext({
            attachments,
            cache,
            cfg,
            limits: resolveFileExtractionLimits(cfg),
            skipAttachmentIndexes:
              audioAttachmentIndexes.size > 0 ? audioAttachmentIndexes : undefined,
            // Placement is the caller's fact. Absent an authoritative host-readable
            // placement, suppress — a wrong path is worse than the plain marker (#122411).
            selfServePathsEnabled: params.selfServeLocalPaths === true,
          });
    // Only processed capabilities have decisions, so audio-only runs cannot
    // add markers for image/video inputs still owned by the native harness.
    const mediaMarkers = renderMediaAttachmentMarkers({
      attachments,
      decisions,
      outputs,
      deliveredImageIndexes: params.deliveredImageIndexes,
    });
    const contextBlocks = applyAttachmentMarkerBudget([...fileContext.blocks, ...mediaMarkers]);
    if (outputs.length > 0 || contextBlocks.length > 0) {
      const enrich = (body?: string) =>
        appendFileBlocks(formatMediaUnderstandingBody({ body, outputs }), contextBlocks);
      // Channels may carry preflight transcripts only in prepared agent text.
      // Enrich that base before changing the separate transport envelope.
      ctx.agentText = enrich(ctx.agentText ?? ctx.BodyForAgent ?? ctx.Body);
      ctx.Body = enrich(ctx.Body);
      finalizeInboundContext(ctx, { forceBodyForCommands: true });
    }

    return {
      outputs,
      decisions,
      extractedFileImages: fileContext.images,
      appliedImage: outputs.some((output) => output.kind === "image.description"),
      appliedAudio: outputs.some((output) => output.kind === "audio.transcription"),
      appliedVideo: outputs.some((output) => output.kind === "video.description"),
      appliedFile: fileContext.blocks.length > 0,
      ...(fileContext.localPathSelfServeUpgrades.length > 0
        ? {
            enableLocalPathSelfServe: (
              contexts: MsgContext[],
              stagedPaths?: ReadonlyMap<number, string>,
            ) =>
              enableLocalPathSelfServe(
                fileContext.localPathSelfServeUpgrades,
                contexts,
                stagedPaths,
              ),
          }
        : {}),
    };
  } finally {
    await cache.cleanup();
  }
}
