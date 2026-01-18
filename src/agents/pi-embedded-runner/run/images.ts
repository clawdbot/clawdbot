import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ImageContent } from "@mariozechner/pi-ai";

import { assertSandboxPath } from "../../sandbox-paths.js";
import { extractTextFromMessage } from "../../../tui/tui-formatters.js";
import { loadWebMedia } from "../../../web/media.js";
import { resolveUserPath } from "../../../utils.js";
import { log } from "../logger.js";

/**
 * Common image file extensions for detection.
 */
const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".tiff",
  ".tif",
  ".heic",
  ".heif",
]);

/**
 * Result of detecting an image reference in text.
 */
export interface DetectedImageRef {
  /** The raw matched string from the prompt */
  raw: string;
  /** The type of reference (path or url) */
  type: "path" | "url";
  /** The resolved/normalized path or URL */
  resolved: string;
  /** Index of the message this ref was found in (for history images) */
  messageIndex?: number;
}

/**
 * Checks if a file extension indicates an image file.
 */
function isImageExtension(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
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
    if (!trimmed || seen.has(trimmed.toLowerCase())) return;
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return;
    if (!isImageExtension(trimmed)) return;
    seen.add(trimmed.toLowerCase());
    const resolved = trimmed.startsWith("~") ? resolveUserPath(trimmed) : trimmed;
    refs.push({ raw: trimmed, type: "path", resolved });
  };

  // Pattern for [media attached: path (type) | url] or [media attached N/M: path (type) | url] format
  // Each bracket = ONE file. The | separates path from URL, not multiple files.
  // Multi-file format uses separate brackets on separate lines.
  const mediaAttachedPattern = /\[media attached(?:\s+\d+\/\d+)?:\s*([^\]]+)\]/gi;
  let match: RegExpExecArray | null;
  while ((match = mediaAttachedPattern.exec(prompt)) !== null) {
    const content = match[1];

    // Skip "[media attached: N files]" header lines
    if (/^\d+\s+files?$/i.test(content.trim())) {
      continue;
    }

    // Extract path before the (mime/type) or | delimiter
    // Format is: path (type) | url  OR  just: path (type)
    // Path may contain spaces (e.g., "ChatGPT Image Apr 21.png")
    // Use non-greedy .+? to stop at first image extension
    const pathMatch = content.match(
      /^\s*(.+?\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|heif))\s*(?:\(|$|\|)/i,
    );
    if (pathMatch?.[1]) {
      addPathRef(pathMatch[1].trim());
    }
  }

  // Pattern for [Image: source: /path/...] format from messaging systems
  const messageImagePattern = /\[Image:\s*source:\s*([^\]]+\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|heif))\]/gi;
  while ((match = messageImagePattern.exec(prompt)) !== null) {
    const raw = match[1]?.trim();
    if (raw) addPathRef(raw);
  }

  // Remote HTTP(S) URLs are intentionally ignored. Native image injection is local-only.

  // Pattern for file:// URLs - treat as paths since loadWebMedia handles them
  const fileUrlPattern =
    /file:\/\/[^\s<>"'`\]]+\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|heif)/gi;
  while ((match = fileUrlPattern.exec(prompt)) !== null) {
    const raw = match[0];
    if (seen.has(raw.toLowerCase())) continue;
    seen.add(raw.toLowerCase());
    // Use fileURLToPath for proper handling (e.g., file://localhost/path)
    try {
      const resolved = fileURLToPath(raw);
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
  const pathPattern = /(?:^|\s|["'`(])((\.\.?\/|[~/])[^\s"'`()[\]]*\.(?:png|jpe?g|gif|webp|bmp|tiff?|heic|heif))/gi;
  while ((match = pathPattern.exec(prompt)) !== null) {
    // Use capture group 1 (the path without delimiter prefix); skip if undefined
    if (match[1]) addPathRef(match[1]);
  }

  return refs;
}

/**
 * Loads an image from a file path or URL and returns it as ImageContent.
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
    /** If set, enforce that file paths are within this sandbox root */
    sandboxRoot?: string;
  },
): Promise<ImageContent | null> {
  try {
    let targetPath = ref.resolved;

    // Remote URL loading is disabled (local-only).
    if (ref.type === "url") {
      log.debug(`Native image: rejecting remote URL (local-only): ${ref.resolved}`);
      return null;
    }

    // For file paths, resolve relative to the appropriate root:
    // - When sandbox is enabled, resolve relative to sandboxRoot for security
    // - Otherwise, resolve relative to workspaceDir
    // Note: ref.resolved may already be absolute (e.g., after ~ expansion in detectImageReferences),
    // in which case we skip relative resolution.
    if (ref.type === "path" && !path.isAbsolute(targetPath)) {
      const resolveRoot = options?.sandboxRoot ?? workspaceDir;
      targetPath = path.resolve(resolveRoot, targetPath);
    }

    // Enforce sandbox restrictions if sandboxRoot is set
    if (ref.type === "path" && options?.sandboxRoot) {
      try {
        const validated = await assertSandboxPath({
          filePath: targetPath,
          cwd: options.sandboxRoot,
          root: options.sandboxRoot,
        });
        targetPath = validated.resolved;
      } catch (err) {
        // Log the actual error for debugging (sandbox violation or other path error)
        log.debug(`Native image: sandbox validation failed for ${ref.resolved}: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    }

    // Check file exists for local paths
    if (ref.type === "path") {
      try {
        await fs.stat(targetPath);
      } catch {
        log.debug(`Native image: file not found: ${targetPath}`);
        return null;
      }
    }

    // loadWebMedia handles local file paths (including file:// URLs)
    const media = await loadWebMedia(targetPath, options?.maxBytes);

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
    log.debug(`Native image: failed to load ${ref.resolved}: ${err instanceof Error ? err.message : String(err)}`);
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
 * Extracts image references from conversation history messages.
 * Scans user messages for image paths/URLs that can be loaded.
 * Each ref includes the messageIndex so images can be injected at their original location.
 *
 * Note: Global deduplication is intentional - if the same image appears in multiple
 * messages, we only inject it at the FIRST occurrence. This is sufficient because:
 * 1. The model sees all message content including the image
 * 2. Later references to "the image" or "that picture" will work since it's in context
 * 3. Injecting duplicates would waste tokens and potentially hit size limits
 */
function detectImagesFromHistory(messages: unknown[]): DetectedImageRef[] {
  const allRefs: DetectedImageRef[] = [];
  const seen = new Set<string>();

  const messageHasImageContent = (msg: unknown): boolean => {
    if (!msg || typeof msg !== "object") return false;
    const content = (msg as { content?: unknown }).content;
    if (!Array.isArray(content)) return false;
    return content.some(
      (part) =>
        part != null &&
        typeof part === "object" &&
        (part as { type?: string }).type === "image",
    );
  };

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") continue;
    const message = msg as { role?: string };
    // Only scan user messages for image references
    if (message.role !== "user") continue;
    // Skip if message already has image content (prevents reloading each turn)
    if (messageHasImageContent(msg)) continue;

    const text = extractTextFromMessage(msg);
    if (!text) continue;

    const refs = detectImageReferences(text);
    for (const ref of refs) {
      const key = ref.resolved.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      allRefs.push({ ...ref, messageIndex: i });
    }
  }

  return allRefs;
}

/**
 * Detects and loads images referenced in a prompt for models with vision capability.
 *
 * This function scans the prompt for image references (file paths and URLs),
 * loads them, and returns them as ImageContent array ready to be passed to
 * the model's prompt method.
 *
 * Also scans conversation history for images from previous turns and returns
 * them mapped by message index so they can be injected at their original location.
 *
 * @param params Configuration for image detection and loading
 * @returns Object with loaded images for current prompt and history images by message index
 */
export async function detectAndLoadPromptImages(params: {
  prompt: string;
  workspaceDir: string;
  model: { input?: string[] };
  existingImages?: ImageContent[];
  historyMessages?: unknown[];
  maxBytes?: number;
  /** If set, enforce that file paths are within this sandbox root */
  sandboxRoot?: string;
}): Promise<{
  /** Images for the current prompt (existingImages + detected in current prompt) */
  images: ImageContent[];
  /** Images from history messages, keyed by message index */
  historyImagesByIndex: Map<number, ImageContent[]>;
  detectedRefs: DetectedImageRef[];
  loadedCount: number;
  skippedCount: number;
}> {
  // If model doesn't support images, return empty results
  if (!modelSupportsImages(params.model)) {
    return {
      images: [],
      historyImagesByIndex: new Map(),
      detectedRefs: [],
      loadedCount: 0,
      skippedCount: 0,
    };
  }

  // Detect images from current prompt
  const promptRefs = detectImageReferences(params.prompt);

  // Detect images from conversation history (with message indices)
  const historyRefs = params.historyMessages
    ? detectImagesFromHistory(params.historyMessages)
    : [];

  // Deduplicate: if an image is in the current prompt, don't also load it from history.
  // Current prompt images are passed via the `images` parameter to prompt(), while history
  // images are injected into their original message positions. We don't want the same
  // image loaded and sent twice (wasting tokens and potentially causing confusion).
  const seenPaths = new Set(promptRefs.map((r) => r.resolved.toLowerCase()));
  const uniqueHistoryRefs = historyRefs.filter(
    (r) => !seenPaths.has(r.resolved.toLowerCase()),
  );

  const allRefs = [...promptRefs, ...uniqueHistoryRefs];

  if (allRefs.length === 0) {
    return {
      images: params.existingImages ?? [],
      historyImagesByIndex: new Map(),
      detectedRefs: [],
      loadedCount: 0,
      skippedCount: 0,
    };
  }

  log.debug(
    `Native image: detected ${allRefs.length} image refs (${promptRefs.length} in prompt, ${uniqueHistoryRefs.length} in history)`,
  );

  // Load images for current prompt
  const promptImages: ImageContent[] = [...(params.existingImages ?? [])];
  // Load images for history, grouped by message index
  const historyImagesByIndex = new Map<number, ImageContent[]>();

  let loadedCount = 0;
  let skippedCount = 0;

  for (const ref of allRefs) {
    const image = await loadImageFromRef(ref, params.workspaceDir, {
      maxBytes: params.maxBytes,
      sandboxRoot: params.sandboxRoot,
    });
    if (image) {
      if (ref.messageIndex !== undefined) {
        // History image - add to the appropriate message index
        const existing = historyImagesByIndex.get(ref.messageIndex);
        if (existing) {
          existing.push(image);
        } else {
          historyImagesByIndex.set(ref.messageIndex, [image]);
        }
      } else {
        // Current prompt image
        promptImages.push(image);
      }
      loadedCount++;
      log.debug(`Native image: loaded ${ref.type} ${ref.resolved}`);
    } else {
      skippedCount++;
    }
  }

  return {
    images: promptImages,
    historyImagesByIndex,
    detectedRefs: allRefs,
    loadedCount,
    skippedCount,
  };
}
