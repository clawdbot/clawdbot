// Portable validation shared by Claw package metadata and grouped manifests.
import {
  AVATAR_MAX_BYTES,
  AVATAR_MAX_DATA_URL_CHARS,
  isRenderableAvatarImageDataUrl,
} from "../shared/avatar-limits.js";
import { isSupportedLocalAvatarExtension } from "../shared/avatar-policy.js";

const EXACT_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const WINDOWS_INVALID_PATH_CHARS = /[<>:"|?*]/;
const WINDOWS_RESERVED_PATH_SEGMENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const BASE64_PAYLOAD_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function isExactSemVer(value: string): boolean {
  return EXACT_VERSION_PATTERN.test(value);
}

export function isCanonicalClawHubPackageName(value: string): boolean {
  return PACKAGE_NAME_PATTERN.test(value);
}

export function isSafeClawRelativePath(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    return false;
  }
  return normalized
    .split("/")
    .every(
      (segment) =>
        segment !== "" &&
        segment !== "." &&
        segment !== ".." &&
        !WINDOWS_INVALID_PATH_CHARS.test(segment) &&
        !Array.from(segment).some((character) => character.charCodeAt(0) <= 0x1f) &&
        !segment.endsWith(".") &&
        !segment.endsWith(" ") &&
        !WINDOWS_RESERVED_PATH_SEGMENT.test(segment),
    );
}

export function portableClawPathKey(value: string): string {
  return value.replaceAll("\\", "/").normalize("NFC").toLowerCase();
}

export function conflictsWithClawPath(targets: Set<string>, candidate: string): boolean {
  for (const target of targets) {
    if (
      target === candidate ||
      target.startsWith(`${candidate}/`) ||
      candidate.startsWith(`${target}/`)
    ) {
      return true;
    }
  }
  return false;
}

export function isPortableClawAvatar(value: string): boolean {
  if (isRenderableAvatarImageDataUrl(value)) {
    if (value.length > AVATAR_MAX_DATA_URL_CHARS) {
      return false;
    }
    const comma = value.indexOf(",");
    if (comma < 0) {
      return false;
    }
    const metadata = value.slice(0, comma);
    const payload = value.slice(comma + 1);
    try {
      const base64 = /;base64(?:;|$)/i.test(metadata);
      if (payload.length === 0 || (base64 && !BASE64_PAYLOAD_PATTERN.test(payload))) {
        return false;
      }
      const bytes = base64
        ? Buffer.from(payload, "base64")
        : Buffer.from(decodeURIComponent(payload), "utf8");
      return bytes.byteLength > 0 && bytes.byteLength <= AVATAR_MAX_BYTES;
    } catch {
      return false;
    }
  }
  return isSafeClawRelativePath(value) && isSupportedLocalAvatarExtension(value);
}

export function isValidClawTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function packageManagerArtifact(command: string, args: string[]): string | undefined {
  const executable = command
    .split(/[\\/]/)
    .at(-1)
    ?.replace(/\.(?:cmd|exe)$/i, "")
    .toLowerCase();
  let start = 0;
  if (executable === "pnpm" || executable === "yarn") {
    if (args[0] !== "dlx") {
      return undefined;
    }
    start = 1;
  } else if (executable !== "npx" && executable !== "pnpx" && executable !== "bunx") {
    return undefined;
  }
  for (let index = start; index < args.length; index += 1) {
    const value = args[index];
    if (!value) {
      continue;
    }
    if (value === "-p" || value === "--package") {
      return args[index + 1];
    }
    if (value.startsWith("--package=")) {
      return value.slice("--package=".length);
    }
    if (!value.startsWith("-")) {
      return value;
    }
  }
  return "";
}

export function isClawPackageManagerArtifactPinned(
  command: string,
  args: string[],
): boolean | undefined {
  const artifact = packageManagerArtifact(command, args);
  if (artifact === undefined) {
    return undefined;
  }
  const separator = artifact.lastIndexOf("@");
  const scopedSlash = artifact.startsWith("@") ? artifact.indexOf("/") : -1;
  return separator > 0 && separator > scopedSlash && isExactSemVer(artifact.slice(separator + 1));
}
