const MAX_PROFILE_AVATAR_EDGE = 512;
const MAX_PROFILE_AVATAR_BYTES = 512 * 1024;
const MAX_PROFILE_AVATAR_BASE64_CHARS = 700_000;
const MAX_PROFILE_AVATAR_SOURCE_BYTES = 10 * 1024 * 1024;

type ProcessedProfileAvatar = {
  mime: "image/png" | "image/webp";
  avatarBase64: string;
  byteLength: number;
};

export class ProfileAvatarError extends Error {
  constructor(readonly code: "invalid-image" | "source-too-large" | "too-large") {
    super(code);
    this.name = "ProfileAvatarError";
  }
}

function fitAvatarDimensions(width: number, height: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new ProfileAvatarError("invalid-image");
  }
  const sourceEdge = Math.min(width, height);
  const scale = Math.min(1, MAX_PROFILE_AVATAR_EDGE / sourceEdge);
  return {
    sourceEdge,
    sourceX: Math.max(0, Math.round((width - sourceEdge) / 2)),
    sourceY: Math.max(0, Math.round((height - sourceEdge) / 2)),
    edge: Math.max(1, Math.round(sourceEdge * scale)),
  };
}

async function loadImage(file: File): Promise<HTMLImageElement> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = objectUrl;
    await image.decode();
    return image;
  } catch {
    throw new ProfileAvatarError("invalid-image");
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function canvasBlob(
  canvas: HTMLCanvasElement,
  mime: ProcessedProfileAvatar["mime"],
  quality?: number,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob(resolve, mime, quality);
  });
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(chunks.join(""));
}

async function encodeAvatarBlob(
  blob: Blob,
  mime: ProcessedProfileAvatar["mime"],
): Promise<ProcessedProfileAvatar> {
  if (blob.size > MAX_PROFILE_AVATAR_BYTES) {
    throw new ProfileAvatarError("too-large");
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const avatarBase64 = bytesToBase64(bytes);
  if (avatarBase64.length > MAX_PROFILE_AVATAR_BASE64_CHARS) {
    throw new ProfileAvatarError("too-large");
  }
  return { mime, avatarBase64, byteLength: bytes.byteLength };
}

export async function processProfileAvatar(file: File): Promise<ProcessedProfileAvatar> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    throw new ProfileAvatarError("invalid-image");
  }
  if (file.size > MAX_PROFILE_AVATAR_SOURCE_BYTES) {
    throw new ProfileAvatarError("source-too-large");
  }
  const image = await loadImage(file);
  const dimensions = fitAvatarDimensions(image.naturalWidth, image.naturalHeight);
  const canvas = document.createElement("canvas");
  canvas.width = dimensions.edge;
  canvas.height = dimensions.edge;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new ProfileAvatarError("invalid-image");
  }
  context.drawImage(
    image,
    dimensions.sourceX,
    dimensions.sourceY,
    dimensions.sourceEdge,
    dimensions.sourceEdge,
    0,
    0,
    dimensions.edge,
    dimensions.edge,
  );

  const preferredMime = file.type === "image/webp" ? "image/webp" : "image/png";
  let mime: ProcessedProfileAvatar["mime"] = preferredMime;
  let blob = await canvasBlob(canvas, mime, mime === "image/webp" ? 0.9 : undefined);
  if (!blob || blob.type !== mime || blob.size > MAX_PROFILE_AVATAR_BYTES) {
    mime = "image/webp";
    blob = await canvasBlob(canvas, mime, 0.82);
  }
  if (!blob || blob.type !== mime) {
    throw new ProfileAvatarError("invalid-image");
  }
  return encodeAvatarBlob(blob, mime);
}
