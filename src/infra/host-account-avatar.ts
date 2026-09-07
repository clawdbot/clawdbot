import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resizeToJpeg } from "../media/image-ops.js";
import { runExec } from "../process/exec.js";
import { readRegularFile } from "./fs-safe.js";

const MAX_ACCOUNT_PHOTO_BYTES = 1024 * 1024;
type HostAccountAvatar = { bytes: Buffer; mime: "image/jpeg"; sha256: string };

// Match host-account-name: one snapshot per Gateway process, including misses.
let cachedAvatar: Promise<HostAccountAvatar | null> | undefined;

async function readAccountAttribute(username: string, attribute: string): Promise<string | null> {
  try {
    const { stdout } = await runExec(
      "/usr/bin/dscl",
      [".", "-read", `/Users/${username}`, attribute],
      { timeoutMs: 1000, maxBuffer: MAX_ACCOUNT_PHOTO_BYTES * 3, logOutput: false },
    );
    const prefix = `${attribute}:`;
    return stdout.startsWith(prefix) ? stdout.slice(prefix.length).trim() : null;
  } catch {
    return null;
  }
}

async function readHostAccountAvatar(): Promise<HostAccountAvatar | null> {
  if (process.platform !== "darwin") {
    return null;
  }
  const { username } = os.userInfo();
  const photo = (await readAccountAttribute(username, "JPEGPhoto"))?.replace(/\s/gu, "");
  let buffer: Buffer;
  if (photo) {
    if (
      photo.length > MAX_ACCOUNT_PHOTO_BYTES * 2 ||
      photo.length % 2 !== 0 ||
      /[^\da-f]/iu.test(photo)
    ) {
      return null;
    }
    buffer = Buffer.from(photo, "hex");
  } else {
    // Stock Picture paths can be symlinks to HEIC files in macOS's asset library.
    const picture = await readAccountAttribute(username, "Picture");
    if (!picture || !path.isAbsolute(picture)) {
      return null;
    }
    ({ buffer } = await readRegularFile({
      filePath: await fs.realpath(picture),
      maxBytes: MAX_ACCOUNT_PHOTO_BYTES,
    }));
  }
  const bytes = await resizeToJpeg({ buffer, maxSide: 256, quality: 85 });
  if (bytes.length === 0 || bytes.length > MAX_ACCOUNT_PHOTO_BYTES) {
    return null;
  }
  return {
    bytes,
    mime: "image/jpeg",
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/** Best-effort macOS host photo; callers bind it only to the Gateway owner. */
export function resolveHostAccountAvatar(): Promise<HostAccountAvatar | null> {
  cachedAvatar ??= readHostAccountAvatar().catch(() => null);
  return cachedAvatar;
}
