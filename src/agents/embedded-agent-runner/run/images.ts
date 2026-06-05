/**
 * Detects, resolves, and loads prompt image references for model input.
 */
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { formatErrorMessage } from "../../../infra/errors.js";
import { assertNoWindowsNetworkPath, safeFileURLToPath } from "../../../infra/local-file-access.js";
import type { ImageContent } from "../../../llm/types.js";
import { resolveMediaReferenceLocalPath } from "../../../media/media-reference.js";
import type { PromptImageOrderEntry } from "../../../media/prompt-image-order.js";
import { loadWebMedia } from "../../../media/web-media.js";
import { resolveUserPath } from "../../../utils.js";
import type { ImageSanitizationLimits } from "../../image-sanitization.js";
import {
  createSandboxBridgeReadFile,
  resolveSandboxedBridgeMediaPath,
} from "../../sandbox-media-paths.js";
import type { SandboxFsBridge } from "../../sandbox/fs-bridge.js";
import { sanitizeImageBlocks } from "../../tool-images.js";
import { log } from "../logger.js";

/**
 * Common image file extensions for detection.
 */
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
const IMAGE_EXTENSIONS = new Set<string>();
for (const ext of IMAGE_EXTENSION_NAMES) {
  IMAGE_EXTENSIONS.add(`.${ext}`);
}
const IMAGE_EXTENSION_PATTERN = IMAGE_EXTENSION_NAMES.join("|");
const MEDIA_ATTACHED_PATH_REGEX_SOURCE =
  "^\\s*(.+?\\.(?:" + IMAGE_EXTENSION_PATTERN + "))\\s*(?:\\(|$|\\|)";
const MESSAGE_IMAGE_REGEX_SOURCE =
  "\\[Image:\\s*source:\\s*([^\\]]+\\.(?:" + IMAGE_EXTENSION_PATTERN + "))\\]";
const FILE_URL_REGEX_SOURCE = "file://[^\\s<>\"'`\\]]+\\.(?:" + IMAGE_EXTENSION_PATTERN + ")";
const WINDOWS_DRIVE_PATH_REGEX_SOURCE =
  "(?:^|\\s|[\"'`(])([A-Za-z]:[\\\\/][^\\s\"'`()\\[\\]]*\\.(?:" + IMAGE_EXTENSION_PATTERN + "))";
const PATH_REGEX_SOURCE =
  "(?:^|\\s|[\"'`(])((\\.\\.?/|[~/])[^\\s\"'`()\\[\\]]*\\.(?:" + IMAGE_EXTENSION_PATTERN + "))";
const MEDIA_ATTACHED_PATTERN = /\[media attached(?:\s+\d+\/\d+)?:\s*([^\]]+)\]/gi;
const MEDIA_ATTACHED_PATH_PATTERN = new RegExp(MEDIA_ATTACHED_PATH_REGEX_SOURCE, "i");
const MESSAGE_IMAGE_PATTERN = new RegExp(MESSAGE_IMAGE_REGEX_SOURCE, "gi");
const FILE_URL_PATTERN = new RegExp(FILE_URL_REGEX_SOURCE, "gi");
const WINDOWS_DRIVE_PATH_PATTERN = new RegExp(WINDOWS_DRIVE_PATH_REGEX_SOURCE, "gi");
const PATH_PATTERN = new RegExp(PATH_REGEX_SOURCE, "gi");

/**
 * Matches the opaque media URI written by the Gateway's claim-check offload:
 *   media://inbound/<uuid-or-id>
 *
 * Uses an exclusion-based character class rather than a whitelist so that
 * Unicode filenames (e.g. Chinese characters) preserved by sanitizeFilename
 * in store.ts are matched correctly.
 *
 * Explicitly excluded from the ID segment:
 *   ]      — closes the surrounding [media attached: ...] bracket
 *   \s     — any whitespace (space, newline, tab) — terminates the token
 *   /      — forward slash path separator (traversal prevention)
 *   \      — back slash path separator (traversal prevention)
 *   \x00   — null byte (path injection prevention)
 *
 * resolveMediaBufferPath applies its own guards against these characters, but
 * excluding them here provides defence-in-depth at the parsing layer.
 *
 * Example valid IDs:
 *   "1c77ce17-20b9-4546-be64-6e36a9adcb2c.png"
 *   "photo---1c77ce17-20b9-4546-be64-6e36a9adcb2c.png"
 *   "图片---1c77ce17-20b9-4546-be64-6e36a9adcb2c.png"
 */
const MEDIA_URI_REGEX = /\bmedia:\/\/inbound\/([^\]\s/\\]+)/;

/**
 * Result of detecting an image reference in text.
 */
export interface DetectedImageRef {
  /** The raw matched string from the prompt */
  raw: string;
  /** The type of reference */
  type: "path" | "media-uri";
  /** The resolved/normalized path, or the raw media URI for media-uri type */
  resolved: string;
}

/**
 * Checks if a file extension indicates an image file.
 */
function isImageExtension(filePath: string): boolean {
  const ext = normalizeLowercaseStringOrEmpty(path.extname(filePath));
  return IMAGE_EXTENSIONS.has(ext);
}

function normalizeRefForDedupe(raw: string): string {
  return process.platform === "win32" ? normalizeLowercaseStringOrEmpty(raw) : raw;
}

function isOpenClawCliImageCachePath(filePath: string): boolean {
  const parts = filePath.replaceAll("\\", "/").split("/");
  return parts.some((part, index) => {
    if (part === ".openclaw-cli-images") {
      return true;
    }
    const parent = parts[index - 1] ?? "";
    return part === "openclaw-cli-images" && /^openclaw(?:-\d+)?$/.test(parent);
  });
}

/**
 * Rebuilds the model image array in the same order the prompt saw them:
 * existing inline images and offloaded attachments follow `imageOrder`, then
 * explicit prompt path/media refs are appended after attachment-owned images.
 */
export function mergePromptAttachmentImages(params: {
  imageOrder?: PromptImageOrderEntry[];
  existingImages?: ImageContent[];
  offloadedImages?: Array<ImageContent | null>;
  promptRefImages?: ImageContent[];
}): ImageContent[] {
  const promptImages: ImageContent[] = [];
  const existingImages = params.existingImages ?? [];
  const offloadedImages = params.offloadedImages ?? [];

  if (params.imageOrder && params.imageOrder.length > 0) {
    let inlineIndex = 0;
    let offloadedIndex = 0;
    for (const entry of params.imageOrder) {
      if (entry === "inline") {
        const image = existingImages[inlineIndex++];
        if (image) {
          promptImages.push(image);
        }
        continue;
      }
      const image = offloadedImages[offloadedIndex++];
      if (image) {
        promptImages.push(image);
      }
    }
    while (inlineIndex < existingImages.length) {
      promptImages.push(existingImages[inlineIndex++]);
    }
    while (offloadedIndex < offloadedImages.length) {
      const image = offloadedImages[offloadedIndex++];
      if (image) {
        promptImages.push(image);
      }
    }
  } else {
    promptImages.push(...existingImages);
    for (const image of offloadedImages) {
      if (image) {
        promptImages.push(image);
      }
    }
  }

  promptImages.push(...(params.promptRefImages ?? []));
  return promptImages;
}

function createRefCountMap(refs: DetectedImageRef[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const ref of refs) {
    const key = `${ref.type}\0${normalizeRefForDedupe(ref.resolved)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function consumeRefCount(counts: Map<string, number>, ref: DetectedImageRef): boolean {
  const key = `${ref.type}\0${normalizeRefForDedupe(ref.resolved)}`;
  const count = counts.get(key) ?? 0;
  if (count <= 0) {
    return false;
  }
  if (count === 1) {
    counts.delete(key);
  } else {
    counts.set(key, count - 1);
  }
  return true;
}

/**
 * Reads only the leading attachment boilerplate block. User-authored image refs
 * after the first blank/non-attachment line must remain prompt refs.
 */
function extractLeadingAttachmentPrompt(prompt: string): string {
  const lines = prompt.split(/\r?\n/);
  const attachmentLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      break;
    }
    if (/^\[media attached:\s*\d+\s+files?\]$/i.test(trimmed)) {
      attachmentLines.push(trimmed);
      continue;
    }
    if (/^\[media attached(?:\s+\d+\/\d+)?:\s*[^\]]+\]$/i.test(trimmed)) {
      attachmentLines.push(trimmed);
      continue;
    }
    break;
  }
  return attachmentLines.join("\n");
}

function extractLeadingInlineAttachmentRefs(prompt: string, count: number): DetectedImageRef[] {
  if (count <= 0) {
    return [];
  }
  const attachmentPrompt = extractLeadingAttachmentPrompt(prompt);
  if (!attachmentPrompt) {
    return [];
  }
  return detectImageReferences(attachmentPrompt).slice(0, count);
}

/**
 * Finds trailing media:// attachment lines produced by claim-check offload. The
 * reverse scan stops at the first non-attachment line so prompt text above it is
 * not accidentally treated as attachment boilerplate.
 */
function extractTrailingAttachmentMediaUris(prompt: string, count: number): string[] {
  if (count <= 0) {
    return [];
  }

  const lines = prompt.split(/\r?\n/);
  const uris: string[] = [];
  for (let index = lines.length - 1; index >= 0 && uris.length < count; index--) {
    const line = lines[index]?.trim();
    if (!line || line.includes("\0")) {
      break;
    }
    const match = line.match(/^\[media attached:\s*(media:\/\/inbound\/[^\]\s/\\]+)\]$/);
    if (!match?.[1]) {
      break;
    }
    uris.push(match[1]);
  }
  for (let left = 0, right = uris.length - 1; left < right; left += 1, right -= 1) {
    const uri = uris[left];
    uris[left] = uris[right];
    uris[right] = uri;
  }
  return uris;
}

/**
 * Separates image refs that came from attachment boilerplate from refs the user
 * actually typed into the prompt. Attachment refs are already represented by
 * existing/offloaded image content and should not be loaded a second time.
 */
export function splitPromptAndAttachmentRefs(params: {
  prompt: string;
  refs: DetectedImageRef[];
  imageOrder?: PromptImageOrderEntry[];
  existingImageCount?: number;
}): {
  promptRefs: DetectedImageRef[];
  attachmentRefs: DetectedImageRef[];
} {
  const existingImageCount = params.existingImageCount ?? 0;
  const inlineOrderCount = params.imageOrder?.filter((entry) => entry === "inline").length;
  // Inline attachments appear at the front of the prompt and are already present in existingImages.
  const inlineAttachmentRefCount = Math.min(
    existingImageCount,
    inlineOrderCount ?? existingImageCount,
  );
  const inlineAttachmentRefs = createRefCountMap(
    extractLeadingInlineAttachmentRefs(params.prompt, inlineAttachmentRefCount),
  );
  const offloadedCount = params.imageOrder?.filter((entry) => entry === "offloaded").length ?? 0;
  // Offloaded claim-check attachments are appended after the prompt and loaded through media://.
  const attachmentUris = new Set(
    offloadedCount > 0 ? extractTrailingAttachmentMediaUris(params.prompt, offloadedCount) : [],
  );

  const promptRefs: DetectedImageRef[] = [];
  const attachmentRefs: DetectedImageRef[] = [];
  for (const ref of params.refs) {
    if (consumeRefCount(inlineAttachmentRefs, ref)) {
      continue;
    }
    if (ref.type === "media-uri" && attachmentUris.has(ref.resolved)) {
      attachmentRefs.push(ref);
      continue;
    }
    promptRefs.push(ref);
  }
  return { promptRefs, attachmentRefs };
}

async function sanitizeImagesWithLog(
  images: ImageContent[],
  label: string,
  imageSanitization?: ImageSanitizationLimits,
): Promise<ImageContent[]> {
  const { images: sanitized, dropped } = await sanitizeImageBlocks(
    images,
    label,
    imageSanitization,
  );
  if (dropped > 0) {
    log.warn(`Native image: dropped ${dropped} image(s) after sanitization (${label}).`);
  }
  return sanitized;
}

/**
 * Detects image references in a user prompt.
 *
 * Patterns detected:
 * - Absolute paths: /path/to/image.png
 * - Relative paths: ./image.png, ../images/photo.jpg
 * - Home paths: ~/Pictures/screenshot.png
 * - file:// URLs: file:///path/to/image.png
 * - Message attachments: [Image: source: /path/to/image.jpg]
 * - Gateway claim-check URIs: [media attached: media://inbound/<id>]
 *
 * @param prompt The user prompt text to scan
 * @returns Array of detected image references
 */
export function detectImageReferences(prompt: string): DetectedImageRef[] {
  const refs: DetectedImageRef[] = [];
  const seen = new Set<string>();

  // Dedupe by the user-visible token before resolving so repeated refs keep their first spelling.
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

  // Pattern for [media attached: path (type) | url] or [media attached N/M: path (type) | url] format
  // Each bracket = ONE file. The | separates path from URL, not multiple files.
  // Multi-file format uses separate brackets on separate lines.
  MEDIA_ATTACHED_PATTERN.lastIndex = 0;
  MESSAGE_IMAGE_PATTERN.lastIndex = 0;
  FILE_URL_PATTERN.lastIndex = 0;
  WINDOWS_DRIVE_PATH_PATTERN.lastIndex = 0;
  PATH_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MEDIA_ATTACHED_PATTERN.exec(prompt)) !== null) {
    const content = match[1];

    // Skip "[media attached: N files]" header lines
    if (/^\d+\s+files?$/i.test(content.trim())) {
      continue;
    }

    // Check for a Gateway claim-check URI first (media://inbound/<id>).
    // This must be tested before the extension-based path regex because the
    // URI has no file extension suffix in its base form.
    const mediaUriMatch = content.match(MEDIA_URI_REGEX);
    if (mediaUriMatch && !mediaUriMatch[1].includes("\0")) {
      const uri = `media://inbound/${mediaUriMatch[1]}`;
      const dedupeKey = normalizeRefForDedupe(uri);
      if (!seen.has(dedupeKey)) {
        seen.add(dedupeKey);
        refs.push({ raw: uri, type: "media-uri", resolved: uri });
      }
      continue;
    }

    // Extract path before the (mime/type) or | delimiter
    // Format is: path (type) | url  OR  just: path (type)
    // Path may contain spaces (e.g., "ChatGPT Image Apr 21.png")
    // Use non-greedy .+? to stop at first image extension
    const pathMatch = content.match(MEDIA_ATTACHED_PATH_PATTERN);
    if (pathMatch?.[1]) {
      addPathRef(pathMatch[1].trim());
    }
  }

  // Pattern for [Image: source: /path/...] format from messaging systems
  while ((match = MESSAGE_IMAGE_PATTERN.exec(prompt)) !== null) {
    const raw = match[1]?.trim();
    if (raw) {
      addPathRef(raw);
    }
  }

  // Remote HTTP(S) URLs are intentionally ignored. Native image injection is local-only.

  // Pattern for file:// URLs - treat as paths since loadWebMedia handles them
  while ((match = FILE_URL_PATTERN.exec(prompt)) !== null) {
    const raw = match[0];
    const dedupeKey = normalizeRefForDedupe(raw);
    if (seen.has(dedupeKey)) {
      continue;
    }
    // Use fileURLToPath for proper handling (e.g., file://localhost/path)
    try {
      const resolved = safeFileURLToPath(raw);
      if (isOpenClawCliImageCachePath(resolved)) {
        continue;
      }
      seen.add(dedupeKey);
      refs.push({ raw, type: "path", resolved });
    } catch {
      // Skip malformed file:// URLs
    }
  }

  // Pattern for Windows drive paths.
  while ((match = WINDOWS_DRIVE_PATH_PATTERN.exec(prompt)) !== null) {
    if (match[1]) {
      addPathRef(match[1]);
    }
  }

  // Pattern for file paths (absolute, relative, or home)
  // Matches:
  // - /absolute/path/to/file.ext (including paths with special chars like Messages/Attachments)
  // - ./relative/path.ext
  // - ../parent/path.ext
  // - ~/home/path.ext
  while ((match = PATH_PATTERN.exec(prompt)) !== null) {
    // Use capture group 1 (the path without delimiter prefix); skip if undefined
    if (match[1]) {
      addPathRef(match[1]);
    }
  }

  return refs;
}

/**
 * Resolves and loads one detected image ref into model-ready image content.
 * Sandbox refs must validate through the bridge; non-sandbox refs can resolve
 * media claim-checks and workspace-relative paths before loadWebMedia enforces
 * local-root and size limits.
 */
export async function loadImageFromRef(
  ref: DetectedImageRef,
  workspaceDir: string,
  options?: {
    maxBytes?: number;
    workspaceOnly?: boolean;
    localRoots?: readonly string[];
    sandbox?: { root: string; bridge: SandboxFsBridge };
  },
): Promise<ImageContent | null> {
  try {
    let targetPath = ref.resolved;

    // media:// claim-check refs are resolved only outside sandbox mode; sandbox
    // mode validates through resolveSandboxedBridgeMediaPath instead.
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
        log.debug(
          `Native image: sandbox validation failed for ${ref.resolved}: ${formatErrorMessage(err)}`,
        );
        return null;
      }
    } else if (!path.isAbsolute(targetPath)) {
      targetPath = path.resolve(workspaceDir, targetPath);
    }

    // loadWebMedia handles local file paths and file:// URLs after the path policy above.
    const media = options?.sandbox
      ? await loadWebMedia(targetPath, {
          maxBytes: options.maxBytes,
          sandboxValidated: true,
          readFile: createSandboxBridgeReadFile({ sandbox: options.sandbox }),
        })
      : await loadWebMedia(
          targetPath,
          options?.workspaceOnly
            ? { maxBytes: options.maxBytes, localRoots: options.localRoots ?? [workspaceDir] }
            : options?.maxBytes,
        );

    if (media.kind !== "image") {
      log.debug(`Native image: not an image file: ${targetPath} (got ${media.kind})`);
      return null;
    }

    // EXIF orientation is already normalized by loadWebMedia -> resizeToJpeg
    // Default to JPEG since optimization converts images to JPEG format
    const mimeType = media.contentType ?? "image/jpeg";
    const data = media.buffer.toString("base64");

    return { type: "image", data, mimeType };
  } catch (err) {
    // Log the actual error for debugging (size limits, network failures, etc.)
    log.debug(`Native image: failed to load ${ref.resolved}: ${formatErrorMessage(err)}`);
    return null;
  }
}

/** Returns whether the resolved model advertises native image input support. */
export function modelSupportsImages(model: { input?: string[] }): boolean {
  return model.input?.includes("image") ?? false;
}

/**
 * Detects, loads, orders, and sanitizes the image payload for one prompt turn.
 * Attachment boilerplate is separated from user-authored refs so existing
 * inline images and offloaded claim-check images are not loaded twice.
 */
export async function detectAndLoadPromptImages(params: {
  prompt: string;
  workspaceDir: string;
  model: { input?: string[] };
  existingImages?: ImageContent[];
  imageOrder?: PromptImageOrderEntry[];
  maxBytes?: number;
  maxDimensionPx?: number;
  workspaceOnly?: boolean;
  localRoots?: readonly string[];
  sandbox?: { root: string; bridge: SandboxFsBridge };
}): Promise<{
  /** Images for the current prompt (existingImages + detected in current prompt) */
  images: ImageContent[];
  detectedRefs: DetectedImageRef[];
  loadedCount: number;
  skippedCount: number;
}> {
  if (!modelSupportsImages(params.model)) {
    return {
      images: [],
      detectedRefs: [],
      loadedCount: 0,
      skippedCount: 0,
    };
  }

  const allRefs = detectImageReferences(params.prompt);

  if (allRefs.length === 0) {
    const sanitizedExistingImages = await sanitizeImagesWithLog(
      params.existingImages ?? [],
      "prompt:images",
      { maxDimensionPx: params.maxDimensionPx },
    );
    return {
      images: sanitizedExistingImages,
      detectedRefs: [],
      loadedCount: 0,
      skippedCount: 0,
    };
  }

  log.debug(`Native image: detected ${allRefs.length} image refs in prompt`);
  const { promptRefs, attachmentRefs } = splitPromptAndAttachmentRefs({
    prompt: params.prompt,
    refs: allRefs,
    imageOrder: params.imageOrder,
    existingImageCount: params.existingImages?.length,
  });
  const promptRefImages: ImageContent[] = [];
  const offloadedImages: Array<ImageContent | null> = [];

  let loadedCount = 0;
  let skippedCount = 0;

  for (const ref of promptRefs) {
    const image = await loadImageFromRef(ref, params.workspaceDir, {
      maxBytes: params.maxBytes,
      workspaceOnly: params.workspaceOnly,
      localRoots: params.localRoots,
      sandbox: params.sandbox,
    });
    if (image) {
      promptRefImages.push(image);
      loadedCount++;
      log.debug(`Native image: loaded ${ref.type} ${ref.resolved}`);
    } else {
      skippedCount++;
    }
  }

  for (const ref of attachmentRefs) {
    const image = await loadImageFromRef(ref, params.workspaceDir, {
      maxBytes: params.maxBytes,
      workspaceOnly: params.workspaceOnly,
      localRoots: params.localRoots,
      sandbox: params.sandbox,
    });
    offloadedImages.push(image);
    if (image) {
      loadedCount++;
      log.debug(`Native image: loaded ${ref.type} ${ref.resolved}`);
    } else {
      skippedCount++;
    }
  }

  const promptImages = mergePromptAttachmentImages({
    imageOrder: params.imageOrder,
    existingImages: params.existingImages,
    offloadedImages,
    promptRefImages,
  });

  const imageSanitization: ImageSanitizationLimits = {
    maxDimensionPx: params.maxDimensionPx,
  };
  const sanitizedPromptImages = await sanitizeImagesWithLog(
    promptImages,
    "prompt:images",
    imageSanitization,
  );

  return {
    images: sanitizedPromptImages,
    detectedRefs: allRefs,
    loadedCount,
    skippedCount,
  };
}
