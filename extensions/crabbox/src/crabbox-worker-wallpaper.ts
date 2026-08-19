import fs from "node:fs";

const WORKER_WALLPAPER_WIDTH = 1920;
const WORKER_WALLPAPER_HEIGHT = 1080;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function loadCrabboxWorkerWallpaperBase64(wallpaperPath: string): string {
  let wallpaper: Buffer;
  try {
    wallpaper = fs.readFileSync(wallpaperPath);
  } catch (cause) {
    throw new Error(`Crabbox worker wallpaper could not be read: ${wallpaperPath}`, { cause });
  }
  if (
    wallpaper.length < 33 ||
    !wallpaper.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
    wallpaper.readUInt32BE(8) !== 13 ||
    wallpaper.toString("ascii", 12, 16) !== "IHDR"
  ) {
    throw new Error(`Crabbox worker wallpaper is not a PNG: ${wallpaperPath}`);
  }
  const width = wallpaper.readUInt32BE(16);
  const height = wallpaper.readUInt32BE(20);
  if (width !== WORKER_WALLPAPER_WIDTH || height !== WORKER_WALLPAPER_HEIGHT) {
    throw new Error(
      `Crabbox worker wallpaper must be ${WORKER_WALLPAPER_WIDTH}x${WORKER_WALLPAPER_HEIGHT}; got ${width}x${height}: ${wallpaperPath}`,
    );
  }
  return wallpaper.toString("base64");
}
