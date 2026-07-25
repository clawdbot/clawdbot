import { MAX_IMAGE_BYTES } from "@openclaw/media-core/constants";
import { isImageMediaFact, resolveMediaFacts } from "../../../media/media-facts.js";
import { resolveImageSanitizationLimits } from "../../image-sanitization.js";
import { resolveAttemptWorkspaceSandbox } from "./attempt-setup.js";
import { detectAndLoadPromptImages } from "./images.js";
import type { RunEmbeddedAgentParams } from "./params.js";
import {
  readPersistedMediaImageLayout,
  readPersistedPromptMediaFacts,
} from "./prompt-image-metadata.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

function toTypeOnlyImageFact(
  fact: NonNullable<RunEmbeddedAgentParams["media"]>[number],
  hydrationSuppressed: boolean,
): NonNullable<RunEmbeddedAgentParams["media"]>[number] {
  return {
    contentType: fact.contentType,
    kind: fact.kind === "sticker" ? "sticker" : "image",
    messageId: fact.messageId,
    transcribed: fact.transcribed,
    ...(fact.hydrationSuppressed === true || hydrationSuppressed
      ? { hydrationSuppressed: true }
      : {}),
  };
}

/** Materializes fact-carried images before a plugin harness owns transport. */
export async function preparePluginHarnessPromptImages(params: {
  runParams: RunEmbeddedAgentParams;
  runtime: {
    sessionId: string;
    sessionKey?: string;
    workspaceDir: string;
    model: EmbeddedRunAttemptParams["model"];
  };
  pluginHarnessOwnsTransport: boolean;
}): Promise<{
  images: RunEmbeddedAgentParams["images"];
  imageOrder: RunEmbeddedAgentParams["imageOrder"];
  media: RunEmbeddedAgentParams["media"];
}> {
  const { runParams, runtime } = params;
  if (!params.pluginHarnessOwnsTransport) {
    return {
      images: runParams.images,
      imageOrder: runParams.imageOrder,
      media: runParams.media,
    };
  }
  const persistedMessage =
    runParams.userTurnTranscriptRecorder?.message ??
    (await runParams.userTurnTranscriptRecorder?.resolveMessage());
  const persistedMedia = persistedMessage
    ? (readPersistedPromptMediaFacts(persistedMessage) ??
      resolveMediaFacts(persistedMessage as unknown as Parameters<typeof resolveMediaFacts>[0]))
    : [];
  const hydrationMedia = persistedMedia.length > 0 ? persistedMedia : runParams.media;
  if (!hydrationMedia?.some(isImageMediaFact)) {
    return {
      images: runParams.images,
      imageOrder: runParams.imageOrder,
      media: runParams.media,
    };
  }

  const workspace = await resolveAttemptWorkspaceSandbox({
    ...runParams,
    cwd: undefined,
    sessionId: runtime.sessionId,
    sessionKey: runtime.sessionKey,
    workspaceDir: runtime.workspaceDir,
  });
  const result = await detectAndLoadPromptImages({
    prompt: "",
    media: hydrationMedia,
    mediaImageLayout: persistedMessage
      ? readPersistedMediaImageLayout(persistedMessage)
      : undefined,
    workspaceDir: workspace.effectiveWorkspace,
    model: runtime.model,
    existingImages: runParams.images,
    imageOrder: runParams.imageOrder,
    maxBytes: MAX_IMAGE_BYTES,
    maxDimensionPx: resolveImageSanitizationLimits(runParams.config).maxDimensionPx,
    localRoots: workspace.effectiveFsWorkspaceOnly
      ? [workspace.effectiveWorkspace, workspace.resolvedWorkspace]
      : undefined,
    workspaceOnly: workspace.effectiveFsWorkspaceOnly,
    sandbox:
      workspace.sandbox?.enabled && workspace.sandbox.fsBridge
        ? { root: workspace.sandbox.workspaceDir, bridge: workspace.sandbox.fsBridge }
        : undefined,
  });
  if (result.failedMediaCount > 0) {
    throw new Error(
      `failed to hydrate ${result.failedMediaCount} structured image attachment(s) for plugin harness input`,
    );
  }
  const materializedFactIndexes = new Set(
    result.imageFactIndexes.filter((index): index is number => index !== null),
  );
  const retainedMedia = hydrationMedia?.map((fact, factIndex) =>
    isImageMediaFact(fact)
      ? toTypeOnlyImageFact(fact, !materializedFactIndexes.has(factIndex))
      : fact,
  );
  return {
    images: result.images,
    imageOrder: result.images.length > 0 ? result.images.map(() => "inline" as const) : undefined,
    media: retainedMedia?.length ? retainedMedia : undefined,
  };
}
