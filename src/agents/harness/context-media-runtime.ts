import { MAX_IMAGE_BYTES } from "@openclaw/media-core/constants";
import { buildInboundMediaNoteProjection } from "../../auto-reply/media-note.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ImageContent } from "../../llm/types.js";
import { prepareFileContextFromMedia } from "../../media-understanding/file-context.js";
import { getAgentScopedMediaLocalRoots } from "../../media/local-roots.js";
import { isImageMediaFact, readPersistedMediaFacts } from "../../media/media-facts.js";
import {
  buildPromptImageFailureNotice,
  detectAndLoadPromptImages,
} from "../embedded-agent-runner/run/images.js";
import {
  readPersistedImageBlockFactIndexes,
  readPersistedMediaImageLayout,
} from "../embedded-agent-runner/run/prompt-image-metadata.js";
import { resolveImageSanitizationLimits } from "../image-sanitization.js";
import type { AgentMessage } from "../runtime/index.js";
import type { SandboxFsBridge } from "../sandbox/fs-bridge.js";
import { resolveEffectiveToolFsWorkspaceOnly } from "../tool-fs-policy.js";
import { sanitizeImageBlocks } from "../tool-images.js";

/** Restores model input without changing the canonical source row or invoking channel delivery. */
export async function prepareHarnessContextMedia(params: {
  message: AgentMessage;
  maxChars: number;
  config?: OpenClawConfig;
  workspaceDir: string;
  modelInput: string[];
  agentId?: string;
  channelId?: string;
  accountId?: string;
  sandbox?: { root: string; bridge: SandboxFsBridge };
  assertCurrent: () => void;
}): Promise<{ text?: string; images: ImageContent[] }> {
  params.assertCurrent();
  if (params.message.role !== "user" || params.maxChars <= 0) {
    return { images: [] };
  }
  if (!Number.isFinite(params.maxChars)) {
    throw new Error("Context media requires a finite character budget");
  }
  const message = params.message;
  const media = readPersistedMediaFacts(message) ?? [];
  const inlineImages = Array.isArray(message.content)
    ? message.content.filter((part): part is ImageContent => part.type === "image")
    : [];
  if (!media.length && !inlineImages.length) {
    return { images: [] };
  }
  const files = await prepareFileContextFromMedia({
    media,
    config: params.config ?? {},
    workspaceDir: params.workspaceDir,
    channelId: params.channelId,
    accountId: params.accountId,
    maxChars: params.maxChars,
    assertCurrent: params.assertCurrent,
  });
  params.assertCurrent();
  const imageFacts = media.filter(isImageMediaFact);
  const text = [files.text];
  if (imageFacts.length || inlineImages.length) {
    text.push(buildInboundMediaNoteProjection({ media: imageFacts }).text ?? "[Image attachment]");
  }
  if (!params.modelInput.includes("image")) {
    if (imageFacts.length || inlineImages.length || files.images.length) {
      text.push("[Attachment images omitted: this model does not support image input]");
    }
    return { text: text.filter(Boolean).join("\n\n"), images: [] };
  }
  const limits = { ...resolveImageSanitizationLimits(params.config), maxBytes: MAX_IMAGE_BYTES };
  const workspaceOnly = resolveEffectiveToolFsWorkspaceOnly({
    cfg: params.config,
    agentId: params.agentId,
  });
  const inlineFactIndexes = readPersistedImageBlockFactIndexes(message);
  const rawImages = await detectAndLoadPromptImages({
    prompt: "",
    workspaceDir: params.workspaceDir,
    model: { input: params.modelInput },
    media,
    mediaImageLayout: readPersistedMediaImageLayout(message),
    existingImages: inlineImages,
    existingImageFactIndexes: inlineFactIndexes,
    workspaceOnly,
    localRoots: workspaceOnly
      ? undefined
      : getAgentScopedMediaLocalRoots(params.config ?? {}, params.agentId, params.workspaceDir),
    sandbox: params.sandbox,
    ...limits,
  });
  params.assertCurrent();
  const entries = rawImages.images.map((image, index) => ({
    image,
    sourceIndex: rawImages.imageFactIndexes[index] ?? media.length + index,
    sequence: index,
  }));
  // The loader counts failed media facts; inline-only blocks have no fact to
  // charge, so include their sanitation drops in the visible disposition too.
  const unownedInlineCount = inlineImages.filter(
    (_, index) => inlineFactIndexes?.[index] == null,
  ).length;
  const retainedUnownedCount = rawImages.imageFactIndexes.filter((index) => index === null).length;
  let failedImages =
    rawImages.failedMediaCount + Math.max(0, unownedInlineCount - retainedUnownedCount);
  for (const page of files.images) {
    params.assertCurrent();
    const sanitized = await sanitizeImageBlocks([page], "context:file", limits);
    params.assertCurrent();
    failedImages += sanitized.dropped;
    for (const image of sanitized.images) {
      entries.push({ image, sourceIndex: page.attachmentIndex, sequence: entries.length });
    }
  }
  if (failedImages) {
    text.push(buildPromptImageFailureNotice(failedImages));
  }
  if (
    (imageFacts.length || inlineImages.length) &&
    !rawImages.images.length &&
    !rawImages.failedMediaCount
  ) {
    text.push("[Referenced image contents are not included in this context]");
  }
  return {
    text: text.filter(Boolean).join("\n\n"),
    images: entries
      .toSorted(
        (left, right) => left.sourceIndex - right.sourceIndex || left.sequence - right.sequence,
      )
      .map(({ image }) => image),
  };
}
