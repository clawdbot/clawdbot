import {
  type SkillLibraryFile,
  type SkillsLibraryReceipt,
  type SkillsLibraryUploadResult,
  SKILL_LIBRARY_MAX_BUNDLE_BYTES,
  SKILL_LIBRARY_MAX_FILE_BYTES,
  SKILL_LIBRARY_MAX_FILES,
} from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { registerSkillLibraryEnglish } from "../../i18n/locales/en-skill-library.ts";

registerSkillLibraryEnglish();

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let start = 0; start < bytes.length; start += 8192) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
  }
  return btoa(binary);
}

export function libraryFileText(file: SkillLibraryFile): string | null {
  if (file.encoding !== "base64") {
    return file.content;
  }
  try {
    const bytes = Uint8Array.from(atob(file.content), (character) => character.charCodeAt(0));
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return text.includes("\0") ? null : text;
  } catch {
    return null;
  }
}

export async function readLibraryFiles(
  input: File[],
): Promise<{ content: string; files: SkillLibraryFile[] }> {
  if (
    input.length > SKILL_LIBRARY_MAX_FILES ||
    input.some((file) => file.size > SKILL_LIBRARY_MAX_FILE_BYTES) ||
    input.reduce((sum, file) => sum + file.size, 0) > SKILL_LIBRARY_MAX_BUNDLE_BYTES
  ) {
    throw new Error(t("skillLibrary.bundleLimit"));
  }
  let content: string | undefined;
  const files: SkillLibraryFile[] = [];
  for (const file of input) {
    const path = file.webkitRelativePath
      ? file.webkitRelativePath.split("/").slice(1).join("/")
      : file.name;
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (path === "SKILL.md") {
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } else {
      files.push({ path, content: base64(bytes), encoding: "base64" });
    }
  }
  if (content === undefined) {
    throw new Error(t("skillLibrary.missingSkill"));
  }
  return { content, files };
}

export async function uploadLibraryArchive(
  client: GatewayBrowserClient,
  file: File,
  slug: string,
  isCurrent: () => boolean,
): Promise<SkillsLibraryReceipt> {
  if (file.size < 1 || file.size > SKILL_LIBRARY_MAX_BUNDLE_BYTES) {
    throw new Error(t("skillLibrary.bundleLimit"));
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const request = (params: unknown) => {
    if (!isCurrent()) {
      throw new Error(t("skillLibrary.connectionChanged"));
    }
    return client.request<SkillsLibraryUploadResult>("skills.library.upload", params);
  };
  const begin = await request({ action: "begin", slug, sizeBytes: bytes.length, sha256 });
  if (!("uploadId" in begin)) {
    throw new Error(t("skillLibrary.uploadFailed"));
  }
  let offset = begin.offset;
  while (offset < bytes.length) {
    const end = Math.min(offset + begin.maxChunkBytes, bytes.length);
    const result = await request({
      action: "chunk",
      uploadId: begin.uploadId,
      offset,
      data: base64(bytes.subarray(offset, end)),
    });
    if (!("offset" in result) || result.offset !== end) {
      throw new Error(t("skillLibrary.uploadFailed"));
    }
    offset = result.offset;
  }
  const result = await request({ action: "commit", uploadId: begin.uploadId });
  if (!("state" in result)) {
    throw new Error(t("skillLibrary.uploadFailed"));
  }
  return result;
}
