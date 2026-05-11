import path from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import { formatErrorMessage } from "../../../infra/errors.js";
import { assertNoWindowsNetworkPath, safeFileURLToPath } from "../../../infra/local-file-access.js";
import type { PromptImageOrderEntry } from "../../../media/prompt-image-order.js";
import { loadWebMedia } from "../../../media/web-media.js";
import { normalizeLowercaseStringOrEmpty } from "../../../shared/string-coerce.js";
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
const PATH_REGEX_SOURCE =
  "(?:^|\\s|[\"'`(])((\\.\\.?/|[~/])[^\\s\"'`()\\[\\]]*\\.(?:" + IMAGE_EXTENSION_PATTERN + "))";
const MEDIA_ATTACHED_PATTERN = /\[media attached(?:\s+\d+\/\d+)?:\s*([^\]]+)\]/gi;
const MEDIA_ATTACHED_PATH_PATTERN = new RegExp(MEDIA_ATTACHED_PATH_REGEX_SOURCE, "i");
const MESSAGE_IMAGE_PATTERN = new RegExp(MESSAGE_IMAGE_REGEX_SOURCE, "gi");
const FILE_URL_PATTERN = new RegExp(FILE_URL_REGEX_SOURCE, "gi");
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
// eslint-disable-next-line no-control-regex
const MEDIA_URI_REGEX = /\bmedia:\/\/inbound\/([^\]\s/\\\x00]+)/;

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

export function splitPromptAndAttachmentRefs(params: {
  prompt: string;
  refs: DetectedImageRef[];
  imageOrder?: PromptImageOrderEntry[];
}): {
  promptRefs: DetectedImageRef[];
  attachmentRefs: DetectedImageRef[];
} {
  const offloadedCount = params.imageOrder?.filter((entry) => entry === "offloaded").length ?? 0;
  if (offloadedCount === 0) {
    return { promptRefs: params.refs, attachmentRefs: [] };
  }

  const attachmentUris = new Set(extractTrailingAttachmentMediaUris(params.prompt, offloadedCount));
  if (attachmentUris.size === 0) {
    return { promptRefs: params.refs, attachmentRefs: [] };
  }

  const promptRefs: DetectedImageRef[] = [];
  const attachmentRefs: DetectedImageRef[] = [];
  for (const ref of params.refs) {
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

  // Helper to add a path ref
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
    seen.add(dedupeKey);
    const resolved = trimmed.startsWith("~") ? resolveUserPath(trimmed) : trimmed;
    refs.push({ raw: trimmed, type: "path", resolved });
  };

  // Pattern for [media attached: path (type) | url] or [media attached N/M: path (type) | url] format
  // Each bracket = ONE file. The | separates path from URL, not multiple files.
  // Multi-file format uses separate brackets on separate lines.
  MEDIA_ATTACHED_PATTERN.lastIndex = 0;
  MESSAGE_IMAGE_PATTERN.lastIndex = 0;
  FILE_URL_PATTERN.lastIndex = 0;
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
    if (mediaUriMatch) {
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
    seen.add(dedupeKey);
    // Use fileURLToPath for proper handling (e.g., file://localhost/path)
    try {
      const resolved = safeFileURLToPath(raw);
      refs.push({ raw, type: "path", resolved });
    } catch {
      // Skip malformed file:// URLs
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
 * Loads an image from a file path and returns it as ImageContent.
 *
 * @param ref The detected image reference
 * @param workspaceDir The current workspace directory for resolving relative paths
 * @param options Optional settings for sandbox and size limits
 * @returns The loaded image content, or null if loading failed
 */
export async function loadImageFromRef(
  ref: DetectedImageRef,
  workspaceDir: string,
  options?: {
    maxBytes?: number;
    workspaceOnly?: boolean;
    sandbox?: { root: string; bridge: SandboxFsBridge };
  },
): Promise<ImageContent | null> {
  try {
    let targetPath = ref.resolved;

    // Resolve paths relative to sandbox or workspace as needed
    if (options?.sandbox) {
      try {
        const resolved = await resolveSandboxedBridgeMediaPath({
          sandbox: {
            root: options.sandbox.root,
            bridge: options.sandbox.bridge,
            workspaceOnly: options.workspaceOnly,
          },
          mediaPath: targetPath,
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

    // loadWebMedia handles local file paths (including file:// URLs)
    const media = options?.sandbox
      ? await loadWebMedia(targetPath, {
          maxBytes: options.maxBytes,
          sandboxValidated: true,
          readFile: createSandboxBridgeReadFile({ sandbox: options.sandbox }),
        })
      : await loadWebMedia(
          targetPath,
          options?.workspaceOnly
            ? { maxBytes: options.maxBytes, localRoots: [workspaceDir] }
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

/**
 * Checks if a model supports image input based on its input capabilities.
 *
 * @param model The model object with input capability array
 * @returns True if the model supports image input
 */
export function modelSupportsImages(model: { input?: string[] }): boolean {
  return model.input?.includes("image") ?? false;
}

/**
 * Detects and loads images referenced in a prompt for models with vision capability.
 *
 * This function scans the prompt for image references (file paths and URLs),
 * loads them, and returns them as ImageContent array ready to be passed to
 * the model's prompt method.
 *
 * @param params Configuration for image detection and loading
 * @returns Object with loaded images for current prompt only
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
  sandbox?: { root: string; bridge: SandboxFsBridge };
}): Promise<{
  /** Images for the current prompt (existingImages + detected in current prompt) */
  images: ImageContent[];
  detectedRefs: DetectedImageRef[];
  loadedCount: number;
  skippedCount: number;
}> {
  // If model doesn't support images, return empty results
  if (!modelSupportsImages(params.model)) {
    return {
      images: [],
      detectedRefs: [],
      loadedCount: 0,
      skippedCount: 0,
    };
  }

  // Detect images from current prompt
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
  });
  const promptRefImages: ImageContent[] = [];
  const offloadedImages: Array<ImageContent | null> = [];

  let loadedCount = 0;
  let skippedCount = 0;

  for (const ref of promptRefs) {
    const image = await loadImageFromRef(ref, params.workspaceDir, {
      maxBytes: params.maxBytes,
      workspaceOnly: params.workspaceOnly,
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
