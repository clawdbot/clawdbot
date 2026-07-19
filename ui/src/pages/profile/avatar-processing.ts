const MAX_PROFILE_AVATAR_EDGE = 256;
const MAX_PROFILE_AVATAR_BYTES = 512 * 1024;
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
  const scale = Math.min(1, MAX_PROFILE_AVATAR_EDGE / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
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
  return { mime, avatarBase64: bytesToBase64(bytes), byteLength: bytes.byteLength };
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
  canvas.width = dimensions.width;
  canvas.height = dimensions.height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new ProfileAvatarError("invalid-image");
  }
  context.drawImage(image, 0, 0, dimensions.width, dimensions.height);

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
