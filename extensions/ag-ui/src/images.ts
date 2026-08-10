import type { Message } from "@ag-ui/core";

// ---------------------------------------------------------------------------
// Multimodal: extract AG-UI image content blocks for the model
// ---------------------------------------------------------------------------

/**
 * OpenClaw's embedded-agent image input: `{ type:"image", data:<base64>,
 * mimeType }` (raw base64 — the provider adds the `data:` prefix). Passed to
 * `runEmbeddedAgent({ images, imageOrder })`; the model must be image-capable
 * (its config `input` must include `"image"`), else the provider drops them.
 */
interface OpenClawImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

function stripDataUriPrefix(value: string): string {
  if (!value.startsWith("data:")) {
    return value;
  }
  const comma = value.indexOf(",");
  return comma >= 0 ? value.slice(comma + 1) : value;
}

function parseDataUri(value: string): { data: string; mimeType: string } | null {
  if (!value.startsWith("data:")) {
    return null;
  }
  const match = /^data:([^;,]+)[^,]*,(.*)$/s.exec(value);
  if (!match) {
    return null;
  }
  return { mimeType: match[1] || "image/png", data: match[2] ?? "" };
}

/**
 * Turn one AG-UI content block into an OpenClaw image, or null if it is not an
 * image. Tolerates the shapes AG-UI emit: an `image` block with a
 * `source` ({type:"data"|"url", value, mimeType}), an `image_url` block
 * ({url}|string), or a flat {data, mimeType}. `url` sources are only usable
 * when they are `data:` URIs (OpenClaw needs inline base64, not a remote fetch).
 */
function imageBlockToContent(block: unknown): OpenClawImageContent | null {
  if (!block || typeof block !== "object") {
    return null;
  }
  const b = block as Record<string, unknown>;
  const btype = b.type;
  if (btype !== "image" && btype !== "image_url" && btype !== "input_image") {
    return null;
  }

  const source = b.source as Record<string, unknown> | undefined;
  if (source && typeof source === "object") {
    const value = typeof source.value === "string" ? source.value : undefined;
    const mime =
      (typeof source.mimeType === "string" && source.mimeType) ||
      (typeof source.mime_type === "string" && source.mime_type) ||
      undefined;
    if (value) {
      if (source.type === "data") {
        return { type: "image", data: stripDataUriPrefix(value), mimeType: mime || "image/png" };
      }
      const parsed = parseDataUri(value);
      if (parsed) {
        return { type: "image", ...parsed };
      }
    }
  }

  const imageUrl = b.image_url;
  const url =
    imageUrl && typeof imageUrl === "object" ? (imageUrl as { url?: unknown }).url : imageUrl;
  if (typeof url === "string") {
    const parsed = parseDataUri(url);
    if (parsed) {
      return { type: "image", ...parsed };
    }
  }

  if (typeof b.data === "string" && b.data) {
    const mime =
      (typeof b.mimeType === "string" && b.mimeType) ||
      (typeof b.mime_type === "string" && b.mime_type) ||
      "image/png";
    return { type: "image", data: stripDataUriPrefix(b.data), mimeType: mime };
  }
  return null;
}

/** Collect every image block across the AG-UI messages, in order. */
export function extractImagesFromMessages(messages: Message[]): OpenClawImageContent[] {
  const images: OpenClawImageContent[] = [];
  for (const msg of messages) {
    const content = (msg as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const block of content) {
      const img = imageBlockToContent(block);
      if (img) {
        images.push(img);
      }
    }
  }
  return images;
}
