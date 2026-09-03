import path from "node:path";
import { readRuntimeImageHistory, withRuntimeImageHistory } from "@openclaw/media-core";
import { MAX_VIDEO_BYTES } from "@openclaw/media-core/constants";
import { normalizeMimeType } from "@openclaw/media-core/mime";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type {
  ModelInputContent,
  ProviderContext,
} from "../../../../packages/ai/src/provider-types.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { assertNoWindowsNetworkPath, safeFileURLToPath } from "../../../infra/local-file-access.js";
import type { Context, ImageContent, TextContent } from "../../../llm/types.js";
import { redactSensitiveText } from "../../../logging/redact.js";
import {
  attachRuntimePromptMediaFacts,
  isImageMediaFact,
  isVideoMediaFact,
  normalizeMediaFacts,
  readRuntimePromptImageOrder,
  readRuntimePromptMediaFacts,
  readPersistedMediaFacts,
  type MediaFact,
} from "../../../media/media-facts.js";
import { resolveMediaReferenceLocalPath } from "../../../media/media-reference.js";
import type { PromptImageOrderEntry } from "../../../media/prompt-image-order.js";
import { finalizeRuntimePromptImages } from "../../../media/runtime-prompt-image-provenance.js";
import { loadWebMedia, type WebMediaResult } from "../../../media/web-media.js";
import {
  readPersistedImageBlockFactIndexes,
  readPersistedMediaImageLayout,
} from "../../../sessions/user-turn-transcript.metadata.js";
import type { UserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.types.js";
import { resolveUserPath } from "../../../utils.js";
import type { ImageSanitizationLimits } from "../../image-sanitization.js";
import type { AgentMessage } from "../../runtime/index.js";
import {
  createSandboxBridgeReadFile,
  resolveSandboxedBridgeMediaPath,
} from "../../sandbox-media-paths.js";
import type { SandboxFsBridge } from "../../sandbox/fs-bridge.js";
import { sanitizeImageBlocks } from "../../tool-images.js";
import { log } from "../logger.js";
import {
  collectMediaImageRefs,
  isOpenClawCliImageCachePath,
  resolveMediaFactLocalRef,
  type MediaFileRef,
  type MediaImageRef,
} from "./images.media-refs.js";
import {
  type ImageFactIndex,
  type MediaImageLayout,
  resolveMediaImageLayout,
} from "./prompt-image-metadata.js";

export { hasHydratableMediaImages } from "./images.media-refs.js";

const IMAGE_EXTENSION_NAMES = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "tiff",
  "tif",
  "heic",
  "heif",
] as const;
const IMAGE_EXTENSIONS = new Set<string>(IMAGE_EXTENSION_NAMES.map((ext) => `.${ext}`));
const IMAGE_EXTENSION_PATTERN = IMAGE_EXTENSION_NAMES.join("|");
const FILE_URL_REGEX_SOURCE = "file://[^\\s<>\"'`\\]]+\\.(?:" + IMAGE_EXTENSION_PATTERN + ")";
const WINDOWS_DRIVE_PATH_REGEX_SOURCE =
  "(?:^|\\s|[\"'`(])([A-Za-z]:[\\\\/][^\\s\"'`()\\[\\]]*\\.(?:" + IMAGE_EXTENSION_PATTERN + "))";
const PATH_REGEX_SOURCE =
  "(?:^|\\s|[\"'`(])((\\.\\.?/|[~/])[^\\s\"'`()\\[\\]]*\\.(?:" + IMAGE_EXTENSION_PATTERN + "))";
const FILE_URL_PATTERN = new RegExp(FILE_URL_REGEX_SOURCE, "gi");
const WINDOWS_DRIVE_PATH_PATTERN = new RegExp(WINDOWS_DRIVE_PATH_REGEX_SOURCE, "gi");
const PATH_PATTERN = new RegExp(PATH_REGEX_SOURCE, "gi");
const LEGACY_ATTACHMENT_MARKER_PATTERN =
  /\[(?:media attached(?:\s+\d+\/\d+)?:|Image:\s*source:)\s*[^\]]+\]/gi;

function isImageExtension(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(normalizeLowercaseStringOrEmpty(path.extname(filePath)));
}

function normalizeRefForDedupe(raw: string): string {
  const projected =
    process.platform === "darwin" && raw.startsWith("/private/var/")
      ? raw.slice("/private".length)
      : raw;
  return process.platform === "win32" ? normalizeLowercaseStringOrEmpty(projected) : projected;
}

type PromptImageEntry = {
  image: ImageContent;
  factIndex: ImageFactIndex;
  // Sanitization may drop earlier images; placement stays tied to the original slot.
  sourceSlotIndex?: number;
};

async function sanitizeImageEntriesWithLog(
  entries: PromptImageEntry[],
  label: string,
  imageSanitization?: ImageSanitizationLimits,
): Promise<{ entries: PromptImageEntry[]; failedMediaCount: number }> {
  const sanitized: PromptImageEntry[] = [];
  let dropped = 0;
  let failedMediaCount = 0;
  for (const entry of entries) {
    const result = await sanitizeImageBlocks([entry.image], label, imageSanitization);
    const image = result.images[0];
    if (image) {
      sanitized.push({
        ...entry,
        image: withRuntimeImageHistory(image, readRuntimeImageHistory(entry.image)),
      });
    }
    dropped += result.dropped;
    if (result.dropped > 0 && entry.factIndex !== null) {
      failedMediaCount++;
    }
  }
  if (dropped > 0) {
    log.warn(`Native image: dropped ${dropped} image(s) after sanitization (${label}).`);
  }
  return { entries: sanitized, failedMediaCount };
}

/** Detects explicit local image paths and file URLs in user prompt text. */
export function detectImageReferences(prompt: string): MediaFileRef[] {
  const refs: MediaFileRef[] = [];
  const seen = new Set<string>();
  const pathPrompt = prompt.replace(LEGACY_ATTACHMENT_MARKER_PATTERN, (marker) =>
    " ".repeat(marker.length),
  );

  const addPathRef = (raw: string) => {
    const trimmed = raw.trim();
    const dedupeKey = normalizeRefForDedupe(trimmed);
    if (!trimmed || seen.has(dedupeKey)) {
      return;
    }
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      return;
    }
    if (!isImageExtension(trimmed)) {
      return;
    }
    try {
      assertNoWindowsNetworkPath(trimmed, "Image path");
    } catch {
      return;
    }
    const resolved = trimmed.startsWith("~") ? resolveUserPath(trimmed) : trimmed;
    if (isOpenClawCliImageCachePath(resolved)) {
      return;
    }
    seen.add(dedupeKey);
    refs.push({ raw: trimmed, type: "path", resolved });
  };

  FILE_URL_PATTERN.lastIndex = 0;
  WINDOWS_DRIVE_PATH_PATTERN.lastIndex = 0;
  PATH_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = FILE_URL_PATTERN.exec(pathPrompt)) !== null) {
    const raw = match[0];
    const dedupeKey = normalizeRefForDedupe(raw);
    if (seen.has(dedupeKey)) {
      continue;
    }
    try {
      const resolved = safeFileURLToPath(raw);
      if (isOpenClawCliImageCachePath(resolved)) {
        continue;
      }
      seen.add(dedupeKey);
      refs.push({ raw, type: "path", resolved });
    } catch {
      continue;
    }
  }

  while ((match = WINDOWS_DRIVE_PATH_PATTERN.exec(pathPrompt)) !== null) {
    if (match[1]) {
      addPathRef(match[1]);
    }
  }

  while ((match = PATH_PATTERN.exec(pathPrompt)) !== null) {
    if (match[1]) {
      addPathRef(match[1]);
    }
  }

  return refs;
}

function refDedupeKey(ref: MediaFileRef, workspaceDir?: string): string {
  const resolved =
    ref.type === "path" && workspaceDir && !path.isAbsolute(ref.resolved)
      ? path.resolve(workspaceDir, ref.resolved)
      : ref.resolved;
  return `${ref.type}\0${normalizeRefForDedupe(resolved)}`;
}

function rawAliasDedupeKey(alias: string): string | undefined {
  return path.isAbsolute(alias) ||
    /^[A-Za-z]:[\\/]/.test(alias) ||
    /^[a-z][a-z0-9+.-]*:/i.test(alias)
    ? normalizeRefForDedupe(alias)
    : undefined;
}

async function loadMediaFromRef(
  ref: MediaFileRef,
  workspaceDir: string,
  options?: {
    label?: string;
    maxBytes?: number;
    signal?: AbortSignal;
    workspaceOnly?: boolean;
    localRoots?: readonly string[];
    sandbox?: { root: string; bridge: SandboxFsBridge };
  },
): Promise<WebMediaResult | null> {
  options?.signal?.throwIfAborted();
  const redactedRef = redactSensitiveText(ref.raw || ref.resolved);
  try {
    let targetPath = ref.resolved;

    if (!options?.sandbox) {
      targetPath = await resolveMediaReferenceLocalPath(targetPath);
    }

    if (options?.sandbox) {
      try {
        const resolved = await resolveSandboxedBridgeMediaPath({
          sandbox: {
            root: options.sandbox.root,
            bridge: options.sandbox.bridge,
            workspaceOnly: options.workspaceOnly,
          },
          mediaPath: targetPath,
          inboundFallbackDir: "media/inbound",
        });
        targetPath = resolved.resolved;
      } catch (err) {
        log.warn(
          `${options?.label ?? "Native media"}: sandbox validation failed for ${redactedRef}: ${redactSensitiveText(formatErrorMessage(err))}`,
        );
        return null;
      }
    } else if (!path.isAbsolute(targetPath)) {
      targetPath = path.resolve(workspaceDir, targetPath);
    }

    const media = options?.sandbox
      ? await loadWebMedia(targetPath, {
          maxBytes: options.maxBytes,
          sandboxValidated: true,
          readFile: createSandboxBridgeReadFile({ sandbox: options.sandbox }),
        })
      : await loadWebMedia(
          targetPath,
          options?.workspaceOnly || options?.localRoots
            ? { maxBytes: options.maxBytes, localRoots: options.localRoots ?? [workspaceDir] }
            : options?.maxBytes,
        );

    options?.signal?.throwIfAborted();
    return media;
  } catch (err) {
    options?.signal?.throwIfAborted();
    log.warn(
      `${options?.label ?? "Native media"}: failed to load ${redactedRef}: ${redactSensitiveText(formatErrorMessage(err))}`,
    );
    return null;
  }
}

async function loadImageFromRef(
  ref: MediaFileRef,
  workspaceDir: string,
  options?: Parameters<typeof loadMediaFromRef>[2],
): Promise<ImageContent | null> {
  const media = await loadMediaFromRef(ref, workspaceDir, { ...options, label: "Native image" });
  if (!media || media.kind !== "image") {
    return null;
  }
  return {
    type: "image",
    data: media.buffer.toString("base64"),
    mimeType: media.contentType ?? "image/jpeg",
  };
}

export async function detectAndLoadPromptImages(params: {
  prompt: string;
  userTurnTranscriptRecorder?: Pick<
    UserTurnTranscriptRecorder,
    "resolveMessage" | "getRuntimeMediaImageLayout"
  >;
  media?: readonly MediaFact[];
  workspaceDir: string;
  model: { input?: string[] };
  existingImages?: ImageContent[];
  existingImageFactIndexes?: readonly ImageFactIndex[];
  imageOrder?: PromptImageOrderEntry[];
  mediaImageLayout?: MediaImageLayout;
  maxBytes?: number;
  maxDimensionPx?: number;
  workspaceOnly?: boolean;
  localRoots?: readonly string[];
  sandbox?: { root: string; bridge: SandboxFsBridge };
}): Promise<{
  images: ImageContent[];
  imageFactIndexes: ImageFactIndex[];
  mediaImageLayout: MediaImageLayout;
  detectedRefs: MediaFileRef[];
  failedMediaCount: number;
  loadedCount: number;
  skippedCount: number;
}> {
  if (!params.model.input?.includes("image")) {
    return {
      ...finalizeRuntimePromptImages([], params.mediaImageLayout),
      detectedRefs: [],
      failedMediaCount: 0,
      loadedCount: 0,
      skippedCount: 0,
    };
  }
  // Deferred transcript preparation can carry fresher facts than the recorder's
  // initial message. Resolve without persisting before choosing image ownership.
  const message = await params.userTurnTranscriptRecorder?.resolveMessage();
  const media = normalizeMediaFacts(
    (message ? readPersistedMediaFacts(message) : undefined) ?? params.media,
  );
  const declaredMediaImageLayout =
    (message
      ? (params.userTurnTranscriptRecorder?.getRuntimeMediaImageLayout?.() ??
        readPersistedMediaImageLayout(message))
      : undefined) ?? params.mediaImageLayout;
  const mediaImageLayout = resolveMediaImageLayout({
    media,
    imageOrder: params.imageOrder,
    mediaImageLayout: declaredMediaImageLayout,
    inlineImageCount: params.existingImages?.length ?? 0,
  });
  const suppressed = new Set(mediaImageLayout.suppressedFactIndexes);
  const refs = collectMediaImageRefs(media);
  const refsByFact = new Map(refs.flatMap((ref) => (ref ? [[ref.factIndex, ref] as const] : [])));
  const slots = mediaImageLayout.slots.flatMap((slot, sourceSlotIndex) =>
    slot.factIndex === undefined || !suppressed.has(slot.factIndex)
      ? [{ ...slot, sourceSlotIndex }]
      : [],
  );
  const layoutInlineIndexes = (declaredMediaImageLayout?.slots ?? mediaImageLayout.slots).flatMap(
    (slot) => (slot.kind === "inline" ? [slot.factIndex ?? null] : []),
  );
  const existingIndexes =
    (message ? readPersistedImageBlockFactIndexes(message) : undefined) ??
    params.existingImageFactIndexes ??
    (layoutInlineIndexes.length === (params.existingImages?.length ?? 0)
      ? layoutInlineIndexes
      : params.existingImages?.map(() => null));
  const unusedExisting = (params.existingImages ?? [])
    .map((image, index) => ({
      image,
      factIndex: existingIndexes?.[index] ?? null,
    }))
    .filter((entry) => entry.factIndex === null || !suppressed.has(entry.factIndex));
  const takeExisting = (
    factIndex: number | undefined,
    allowUnowned: boolean,
  ): PromptImageEntry | undefined => {
    const exact =
      factIndex === undefined
        ? -1
        : unusedExisting.findIndex((entry) => entry.factIndex === factIndex);
    const index =
      exact >= 0
        ? exact
        : allowUnowned
          ? unusedExisting.findIndex((entry) => entry.factIndex === null)
          : -1;
    return index >= 0 ? unusedExisting.splice(index, 1)[0] : undefined;
  };
  const availableRefs = refs.filter((ref): ref is MediaImageRef => Boolean(ref));
  const attachmentRefs = slots.flatMap((slot) =>
    slot.kind === "offloaded" && slot.factIndex !== undefined
      ? (refsByFact.get(slot.factIndex) ?? [])
      : [],
  );
  const attachmentKeys = new Set(
    attachmentRefs.map((ref) => refDedupeKey(ref, ref.workspaceDir ?? params.workspaceDir)),
  );
  const attachmentRawKeys = new Set(
    attachmentRefs.flatMap((ref) => ref.aliases.flatMap((alias) => rawAliasDedupeKey(alias) ?? [])),
  );
  const promptRefs = detectImageReferences(params.prompt).filter(
    (ref) =>
      !attachmentRawKeys.has(rawAliasDedupeKey(ref.raw) ?? "") &&
      !attachmentKeys.has(refDedupeKey(ref, params.workspaceDir)),
  );
  const detectedRefs = [
    ...availableRefs.flatMap(({ detect, hydrate, raw, type, resolved }) =>
      detect !== false &&
      (hydrate || (!resolved.startsWith("http://") && !resolved.startsWith("https://")))
        ? [{ raw, type, resolved }]
        : [],
    ),
    ...promptRefs,
  ];
  let loadedCount = 0;
  let failedMediaCount = 0;
  let skippedCount = 0;
  const loadRef = async (ref: MediaFileRef & { workspaceDir?: string }) => {
    const image = await loadImageFromRef(ref, ref.workspaceDir ?? params.workspaceDir, {
      maxBytes: params.maxBytes,
      workspaceOnly: params.workspaceOnly,
      localRoots: params.localRoots ?? (params.workspaceOnly ? [params.workspaceDir] : undefined),
      sandbox: params.sandbox,
    });
    if (image) {
      loadedCount++;
      log.debug(`Native image: loaded ${ref.type} ${ref.resolved}`);
    } else {
      skippedCount++;
    }
    return image;
  };
  const promptImages: PromptImageEntry[] = [];
  for (const slot of slots) {
    const existing = takeExisting(slot.factIndex, slot.kind === "inline");
    if (existing) {
      promptImages.push({ ...existing, sourceSlotIndex: slot.sourceSlotIndex });
      continue;
    }
    // Gateway-owned transcripts retain managed facts, not necessarily inline bytes.
    // A missing inline block must hydrate its exact fact on replay, just like an offloaded slot.
    const ref = slot.factIndex === undefined ? undefined : refsByFact.get(slot.factIndex);
    const image = ref?.hydrate ? await loadRef(ref) : null;
    if ((ref?.hydrate || slot.kind === "inline") && !image) {
      failedMediaCount++;
    }
    if (image) {
      promptImages.push({
        image,
        factIndex: ref?.factIndex ?? null,
        sourceSlotIndex: slot.sourceSlotIndex,
      });
    }
  }
  promptImages.push(...unusedExisting);
  for (const ref of promptRefs) {
    const image = await loadRef(ref);
    if (image) {
      promptImages.push({ image, factIndex: null });
    }
  }
  const sanitizedPromptImages = await sanitizeImageEntriesWithLog(promptImages, "prompt:images", {
    maxBytes: params.maxBytes,
    maxDimensionPx: params.maxDimensionPx,
  });
  const finalized = finalizeRuntimePromptImages(sanitizedPromptImages.entries, mediaImageLayout);

  return {
    ...finalized,
    detectedRefs,
    failedMediaCount: failedMediaCount + sanitizedPromptImages.failedMediaCount,
    loadedCount,
    skippedCount,
  };
}

type PromptMediaOptions = {
  workspaceDir: string;
  model: { input?: string[] };
  maxBytes?: number;
  maxDimensionPx?: number;
  workspaceOnly?: boolean;
  localRoots?: readonly string[];
  sandbox?: { root: string; bridge: SandboxFsBridge };
  provider?: boolean;
  signal?: AbortSignal;
  onCurrentTurnImageFailure?: (count: number) => void;
};

export function buildPromptImageFailureNotice(count: number): string {
  return `System note: ${count} image attachment${count === 1 ? "" : "s"} could not be loaded; their image contents are unavailable. Tell the user and ask them to resend ${count === 1 ? "the image" : "the images"}; do not claim inspection.`;
}

const VIDEO_OMISSION = {
  unsupported: "(video omitted: provider does not support native video)",
  unavailable: "(video omitted: source unavailable)",
  invalid: "(video omitted: invalid video MIME type)",
  limit: "(video omitted: native video byte limit exceeded)",
} as const;

async function materializeVideoFact(
  fact: MediaFact,
  budget: { remaining: number },
  options: PromptMediaOptions,
): Promise<ModelInputContent> {
  if ((fact.sizeBytes ?? 0) > budget.remaining) {
    return { type: "text", text: VIDEO_OMISSION.limit };
  }
  const ref = resolveMediaFactLocalRef(fact);
  const loaded = ref
    ? await loadMediaFromRef(ref, fact.workspaceDir ?? options.workspaceDir, {
        label: "Native video",
        maxBytes: budget.remaining,
        signal: options.signal,
        workspaceOnly: options.workspaceOnly,
        localRoots:
          options.localRoots ?? (options.workspaceOnly ? [options.workspaceDir] : undefined),
        sandbox: options.sandbox,
      })
    : null;
  if (!loaded) {
    return { type: "text", text: VIDEO_OMISSION.unavailable };
  }
  const mimeType = normalizeMimeType(loaded.contentType);
  if (loaded.kind !== "video" || !mimeType?.startsWith("video/")) {
    return { type: "text", text: VIDEO_OMISSION.invalid };
  }
  if (loaded.buffer.length > budget.remaining) {
    return { type: "text", text: VIDEO_OMISSION.limit };
  }
  budget.remaining -= loaded.buffer.length;
  return { type: "video", data: loaded.buffer.toString("base64"), mimeType };
}

async function projectOrderedPromptMedia(params: {
  content: Array<TextContent | ImageContent>;
  media: MediaFact[];
  images: ImageContent[];
  imageFactIndexes: ImageFactIndex[];
  mediaImageLayout: MediaImageLayout;
  options: PromptMediaOptions;
  budget: { remaining: number };
}): Promise<{
  content: ModelInputContent[];
  imageFactIndexes: ImageFactIndex[];
  mediaImageLayout: MediaImageLayout;
}> {
  const generatedMarkers = new Set<string>(Object.values(VIDEO_OMISSION));
  const projected: ModelInputContent[] = params.content.filter(
    (block): block is TextContent => block.type === "text" && !generatedMarkers.has(block.text),
  );
  // Hydration already resolved image order, including inline blocks with no managed fact.
  if (!params.media.some(isVideoMediaFact)) {
    return {
      content: [...projected, ...params.images],
      imageFactIndexes: params.imageFactIndexes,
      mediaImageLayout: params.mediaImageLayout,
    };
  }
  const projectedImageFactIndexes: ImageFactIndex[] = [];
  const projectedSlots: Array<MediaImageLayout["slots"][number]> = [];
  const imagesByFact = new Map<number, ImageContent[]>();
  const factlessImages: ImageContent[] = [];
  params.images.forEach((image, index) => {
    const factIndex = params.imageFactIndexes[index];
    if (factIndex == null) {
      factlessImages.push(image);
    } else {
      imagesByFact.set(factIndex, [...(imagesByFact.get(factIndex) ?? []), image]);
    }
  });
  for (const [factIndex, fact] of params.media.entries()) {
    if (isImageMediaFact(fact)) {
      const images = imagesByFact.get(factIndex) ?? [];
      projected.push(...images);
      projectedImageFactIndexes.push(...images.map(() => factIndex));
      projectedSlots.push(
        ...params.mediaImageLayout.slots.filter((slot) => slot.factIndex === factIndex),
      );
    } else if (isVideoMediaFact(fact)) {
      projected.push(
        params.options.provider
          ? await materializeVideoFact(fact, params.budget, params.options)
          : { type: "text", text: VIDEO_OMISSION.unsupported },
      );
    }
  }
  projected.push(...factlessImages);
  projectedImageFactIndexes.push(...factlessImages.map(() => null));
  projectedSlots.push(
    ...params.mediaImageLayout.slots.filter((slot) => slot.factIndex === undefined),
  );
  return {
    content: projected,
    imageFactIndexes: projectedImageFactIndexes,
    mediaImageLayout: { ...params.mediaImageLayout, slots: projectedSlots },
  };
}

/** Hydrates exact-message media facts for canonical replay or one provider call. */
async function materializePromptMediaMessages(
  messages: AgentMessage[],
  options: PromptMediaOptions,
): Promise<AgentMessage[]> {
  let hydrated: AgentMessage[] | undefined;
  const videoBudget = { remaining: MAX_VIDEO_BYTES };
  const activeUserIndex = messages.findLastIndex((message) => message.role === "user");
  for (const [index, message] of messages.entries()) {
    if (message.role !== "user") {
      continue;
    }
    const runtimeMedia = readRuntimePromptMediaFacts(message);
    const meta = Reflect.get(message, "__openclaw");
    const resolvedMedia = runtimeMedia ?? readPersistedMediaFacts(message) ?? [];
    const runtimeImageOrder = readRuntimePromptImageOrder(message);
    const mediaImageLayout = readPersistedMediaImageLayout(message);
    const content = Array.isArray(message.content)
      ? message.content
      : [{ type: "text" as const, text: message.content }];
    const existingImages = content.filter((block): block is ImageContent => block.type === "image");
    // Accepted steering can carry retained inline images without current-turn
    // media facts. It still needs the selected model's image preparation.
    if (!resolvedMedia.length && !existingImages.some(readRuntimeImageHistory)) {
      continue;
    }
    const result = await detectAndLoadPromptImages({
      prompt: "",
      media: resolvedMedia,
      workspaceDir: options.workspaceDir,
      model: options.model,
      existingImages,
      existingImageFactIndexes: readPersistedImageBlockFactIndexes(message),
      mediaImageLayout,
      maxBytes: options.maxBytes,
      maxDimensionPx: options.maxDimensionPx,
      workspaceOnly: options.workspaceOnly,
      localRoots: options.localRoots,
      sandbox: options.sandbox,
    });
    const projection = await projectOrderedPromptMedia({
      content,
      media: resolvedMedia,
      images: result.images,
      imageFactIndexes: result.imageFactIndexes,
      mediaImageLayout: result.mediaImageLayout,
      options,
      budget: videoBudget,
    });
    const projectedContent = projection.content;
    if (
      (options.provider || options.onCurrentTurnImageFailure) &&
      index === activeUserIndex &&
      result.failedMediaCount > 0
    ) {
      options.onCurrentTurnImageFailure?.(result.failedMediaCount);
      projectedContent.push({
        type: "text",
        text: buildPromptImageFailureNotice(result.failedMediaCount),
      });
    }
    hydrated ??= messages.slice();
    if (options.provider) {
      hydrated[index] = {
        role: "user",
        content: projectedContent,
        timestamp: message.timestamp,
        ...(message.runtimeContextCarrier ? { runtimeContextCarrier: true } : {}),
      } as ProviderContext["messages"][number] as AgentMessage;
      continue;
    }
    const nextMeta =
      meta && typeof meta === "object" && !Array.isArray(meta)
        ? { ...(meta as Record<string, unknown>) }
        : {};
    if (projection.imageFactIndexes.length > 0) {
      nextMeta.mediaImageBlockFactIndexes = projection.imageFactIndexes;
    } else {
      delete nextMeta.mediaImageBlockFactIndexes;
    }
    if (
      projection.mediaImageLayout.slots.length ||
      projection.mediaImageLayout.suppressedFactIndexes?.length
    ) {
      nextMeta.mediaImageLayout = projection.mediaImageLayout;
    } else {
      delete nextMeta.mediaImageLayout;
    }
    const hydratedMessage = {
      ...message,
      content: projectedContent,
    } as AgentMessage;
    if (Object.keys(nextMeta).length > 0) {
      Reflect.set(hydratedMessage, "__openclaw", nextMeta);
    } else {
      Reflect.deleteProperty(hydratedMessage, "__openclaw");
    }
    if (runtimeMedia) {
      attachRuntimePromptMediaFacts(hydratedMessage, runtimeMedia, runtimeImageOrder);
    }
    hydrated[index] = hydratedMessage;
  }
  return hydrated ?? messages;
}

/** Hydrates non-enumerable facts carried by queued user turns before canonical replay. */
export async function hydratePromptMediaMessages(
  messages: AgentMessage[],
  options: Omit<PromptMediaOptions, "provider">,
): Promise<AgentMessage[]> {
  return await materializePromptMediaMessages(messages, options);
}

/** Materializes one transient provider context from exact-message media facts. */
export async function materializeProviderContext(params: {
  context: Context;
  signal?: AbortSignal;
  workspaceDir: string;
  workspaceOnly?: boolean;
  localRoots?: readonly string[];
  sandbox?: { root: string; bridge: SandboxFsBridge };
  onCurrentTurnImageFailure?: (count: number) => void;
}): Promise<ProviderContext> {
  const messages = await materializePromptMediaMessages(params.context.messages as AgentMessage[], {
    workspaceDir: params.workspaceDir,
    model: { input: ["text", "image"] },
    workspaceOnly: params.workspaceOnly,
    localRoots: params.localRoots,
    sandbox: params.sandbox,
    provider: true,
    signal: params.signal,
    onCurrentTurnImageFailure: params.onCurrentTurnImageFailure,
  });
  params.signal?.throwIfAborted();
  return messages === params.context.messages
    ? (params.context as ProviderContext)
    : ({ ...params.context, messages } as ProviderContext);
}
