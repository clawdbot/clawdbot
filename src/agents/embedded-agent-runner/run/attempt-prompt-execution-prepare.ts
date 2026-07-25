/** Prepares prompt-lock ownership and prompt-local images for submission. */
import { MAX_IMAGE_BYTES } from "@openclaw/media-core/constants";
import type { OwnedSessionTranscriptCacheSnapshot } from "../../../config/sessions/transcript-write-context.js";
import { resolveMediaFacts } from "../../../media/media-facts.js";
import { resolveImageSanitizationLimits } from "../../image-sanitization.js";
import type { SandboxContext } from "../../sandbox/types.js";
import type { AgentSession } from "../../sessions/index.js";
import {
  type EmbeddedAttemptSessionLockController,
  installPromptSubmissionLockRelease,
} from "./attempt.session-lock.js";
import { detectAndLoadPromptImages } from "./images.js";
import {
  readPersistedMediaImageLayout,
  readPersistedPromptMediaFacts,
} from "./prompt-image-metadata.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type PromptExecutionAttempt = Pick<
  EmbeddedRunAttemptParams,
  | "config"
  | "imageOrder"
  | "images"
  | "media"
  | "model"
  | "sessionFile"
  | "sessionKey"
  | "userTurnTranscriptRecorder"
>;
type PromptImageResult = Awaited<ReturnType<typeof detectAndLoadPromptImages>>;

function emptyPromptImages(): PromptImageResult {
  return {
    images: [],
    imageFactIndexes: [],
    detectedRefs: [],
    failedMediaCount: 0,
    loadedCount: 0,
    skippedCount: 0,
  };
}

export async function prepareEmbeddedAttemptPromptExecution(input: {
  attempt: PromptExecutionAttempt;
  effectiveFsWorkspaceOnly: boolean;
  effectiveWorkspace: string;
  prompt: string;
  sandbox?: SandboxContext | null;
  session: AgentSession;
  sessionLockController: EmbeddedAttemptSessionLockController;
  skipPromptSubmission: boolean;
}): Promise<PromptImageResult> {
  if (input.skipPromptSubmission) {
    return emptyPromptImages();
  }

  const { attempt } = input;
  installPromptSubmissionLockRelease({
    session: input.session,
    waitForSessionEvents: (sessionToDrain) =>
      input.sessionLockController.waitForSessionEvents(sessionToDrain),
    releaseForPrompt: () => input.sessionLockController.releaseForPrompt(),
    reacquireAfterPrompt: () => input.sessionLockController.reacquireAfterPrompt(),
    sessionKey: attempt.sessionKey,
    sessionFile: attempt.sessionFile,
    withSessionWriteLock: (run, options) =>
      input.sessionLockController.withSessionWriteLock(run, options),
    canAdvanceSessionEntryCache: (snapshot: OwnedSessionTranscriptCacheSnapshot) =>
      input.sessionLockController.canAdvanceSessionEntryCache(snapshot),
    publishSessionFileSnapshot: (snapshot: OwnedSessionTranscriptCacheSnapshot) =>
      input.sessionLockController.publishOwnedSessionFileSnapshot(snapshot),
  });

  const persistedMessage =
    attempt.userTurnTranscriptRecorder?.message ??
    (await attempt.userTurnTranscriptRecorder?.resolveMessage());
  const persistedMedia = persistedMessage
    ? (readPersistedPromptMediaFacts(persistedMessage) ??
      resolveMediaFacts(persistedMessage as unknown as Parameters<typeof resolveMediaFacts>[0]))
    : [];

  return await detectAndLoadPromptImages({
    prompt: input.prompt,
    workspaceDir: input.effectiveWorkspace,
    model: attempt.model,
    existingImages: attempt.images,
    imageOrder: attempt.imageOrder,
    media: persistedMedia.length > 0 ? persistedMedia : attempt.media,
    mediaImageLayout: persistedMessage
      ? readPersistedMediaImageLayout(persistedMessage)
      : undefined,
    maxBytes: MAX_IMAGE_BYTES,
    maxDimensionPx: resolveImageSanitizationLimits(attempt.config).maxDimensionPx,
    workspaceOnly: input.effectiveFsWorkspaceOnly,
    sandbox:
      input.sandbox?.enabled && input.sandbox.fsBridge
        ? { root: input.sandbox.workspaceDir, bridge: input.sandbox.fsBridge }
        : undefined,
  });
}
