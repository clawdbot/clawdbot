// Slack plugin module implements file reference behavior.
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { SlackFile } from "./types.js";

export function formatSlackFileReference(file: SlackFile | undefined): string {
  const name = normalizeOptionalString(file?.name) ?? "file";
  const mimetype = normalizeOptionalString(file?.mimetype);
  const size = file?.size;
  const fileId = normalizeOptionalString(file?.id);
  const metadata = [
    mimetype,
    typeof size === "number" && Number.isSafeInteger(size) && size >= 0
      ? `${size} bytes`
      : undefined,
    fileId ? `fileId: ${fileId}` : undefined,
  ].filter((value): value is string => value !== undefined);
  return metadata.length > 0 ? `${name} (${metadata.join(", ")})` : name;
}

export function formatSlackFileReferenceList(files: readonly SlackFile[] | undefined): string {
  if (!files?.length) {
    return "file";
  }
  return files.map((file) => formatSlackFileReference(file)).join(", ");
}
