import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { DriveItemProperties } from "./graph-upload.js";

export function buildTeamsFileInfoCard(file: DriveItemProperties): {
  contentType: string;
  contentUrl: string;
  name: string;
  content: {
    uniqueId: string;
    fileType: string;
  };
} {
  // Extract unique ID from eTag (remove quotes, braces, and version suffix)
  // Example eTag formats: "{GUID},version" or "\"{GUID},version\""
  const rawETag = file.eTag;
  const uniqueId =
    rawETag
      .replace(/^["']|["']$/g, "") // Remove outer quotes
      .replace(/[{}]/g, "") // Remove curly braces
      .split(",")[0] ?? rawETag; // Take the GUID part before comma

  // Extract file extension from filename
  const lastDot = file.name.lastIndexOf(".");
  const fileType =
    lastDot >= 0 ? normalizeLowercaseStringOrEmpty(file.name.slice(lastDot + 1)) : "";

  return {
    contentType: "application/vnd.microsoft.teams.card.file.info",
    contentUrl: file.webDavUrl,
    name: file.name,
    content: {
      uniqueId,
      fileType,
    },
  };
}
