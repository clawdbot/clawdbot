import { MAX_IMAGE_BYTES } from "@openclaw/media-core/constants";
import { getAgentScopedMediaLocalRoots } from "../../../media/local-roots.js";
import { resolveImageSanitizationLimits } from "../../image-sanitization.js";
import type { SandboxContext } from "../../sandbox/types.js";
import { detectAndLoadPromptImages } from "./images.js";
import type { RunEmbeddedAgentParams } from "./params.js";

type PromptExecutionAttempt = Pick<
  RunEmbeddedAgentParams,
  "config" | "imageOrder" | "images" | "media" | "userTurnTranscriptRecorder"
> & { model: { input?: string[] } };
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

/** Prepares ordered prompt images using the admitted media and filesystem policy. */
export async function prepareEmbeddedAttemptPromptExecution(input: {
  attempt: PromptExecutionAttempt;
  /** Prepared run owner; scopes media roots without re-resolving session identity. */
  mediaOwnerAgentId: string;
  effectiveFsWorkspaceOnly: boolean;
  effectiveWorkspace: string;
  prompt: string;
  sandbox?: SandboxContext | null;
  skipPromptSubmission: boolean;
  pluginHarness?: boolean;
}): Promise<
  PromptImageResult & {
    imageOrder?: PromptExecutionAttempt["imageOrder"];
    media?: PromptExecutionAttempt["media"];
  }
> {
  if (input.skipPromptSubmission) {
    return emptyPromptImages();
  }

  const { attempt } = input;
  const result = await detectAndLoadPromptImages({
    prompt: input.prompt,
    workspaceDir: input.effectiveWorkspace,
    model: attempt.model,
    existingImages: attempt.images,
    imageOrder: attempt.imageOrder,
    media: attempt.media,
    userTurnTranscriptRecorder: attempt.userTurnTranscriptRecorder,
    maxBytes: MAX_IMAGE_BYTES,
    maxDimensionPx: resolveImageSanitizationLimits(attempt.config).maxDimensionPx,
    workspaceOnly: input.effectiveFsWorkspaceOnly,
    localRoots: input.effectiveFsWorkspaceOnly
      ? undefined
      : getAgentScopedMediaLocalRoots(attempt.config ?? {}, input.mediaOwnerAgentId),
    sandbox:
      input.sandbox?.enabled && input.sandbox.fsBridge
        ? { root: input.sandbox.workspaceDir, bridge: input.sandbox.fsBridge }
        : undefined,
  });
  if (!input.pluginHarness) {
    return result;
  }
  if (result.failedMediaCount) {
    throw new Error(
      `failed to hydrate ${result.failedMediaCount} structured image attachment(s) for plugin harness input`,
    );
  }
  return {
    ...result,
    imageOrder: result.images.length ? result.images.map(() => "inline" as const) : undefined,
    media: undefined,
  };
}
