import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { googleApiError } from "./google-api-errors.js";

const GOOGLE_DRIVE_API_BASE_URL = "https://www.googleapis.com/drive/v3";
const GOOGLE_DRIVE_API_HOST = "www.googleapis.com";
const GOOGLE_DRIVE_MEET_SCOPE = "https://www.googleapis.com/auth/drive.meet.readonly";
const TEXT_PLAIN_MIME = "text/plain";

function appendQuery(url: string, query: Record<string, string | undefined>) {
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      parsed.searchParams.set(key, value);
    }
  }
  return parsed.toString();
}

export function extractGoogleDriveDocumentId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      const documentMatch = url.pathname.match(/\/document\/d\/([^/]+)/);
      return documentMatch?.[1];
    } catch {
      return undefined;
    }
  }
  const segments = trimmed.split("/").filter(Boolean);
  return segments.at(-1);
}

export async function exportGoogleDriveDocumentText(params: {
  accessToken: string;
  documentId: string;
}): Promise<string> {
  const { response, release } = await fetchWithSsrFGuard({
    url: appendQuery(
      `${GOOGLE_DRIVE_API_BASE_URL}/files/${encodeURIComponent(params.documentId)}/export`,
      { mimeType: TEXT_PLAIN_MIME },
    ),
    init: {
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        Accept: TEXT_PLAIN_MIME,
      },
    },
    policy: { allowedHostnames: [GOOGLE_DRIVE_API_HOST] },
    auditContext: "google-meet.drive.files.export",
  });
  try {
    if (!response.ok) {
      const detail = await response.text();
      throw await googleApiError({
        response,
        detail,
        prefix: "Google Drive files.export",
        scopes: [GOOGLE_DRIVE_MEET_SCOPE],
      });
    }
    return await response.text();
  } finally {
    await release();
  }
}
