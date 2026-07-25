import {
  isBlockedHostnameOrIp,
  resolvePinnedHostnameWithPolicy,
} from "openclaw/plugin-sdk/ssrf-runtime";

const FEISHU_MEDIA_UPLOAD_FAILURE_FALLBACK_TEXT = "Media upload failed. Please try again.";

function hasAsciiControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

async function resolvePublicFeishuMediaReference(
  value: string | undefined,
): Promise<string | undefined> {
  const raw = value?.trim();
  if (!raw || hasAsciiControlCharacter(raw)) {
    return undefined;
  }
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return undefined;
    }
    if (parsed.username || parsed.password || isBlockedHostnameOrIp(parsed.hostname)) {
      return undefined;
    }
    // A proxy route cannot prove its destination is public. Fail closed unless
    // local pinned DNS validates the URL without private or special-use answers.
    await resolvePinnedHostnameWithPolicy(parsed.hostname);
    return parsed.href;
  } catch {
    return undefined;
  }
}

export async function buildFeishuMediaFallbackText(params: {
  text?: string;
  mediaUrl?: string;
  mediaLinkStyle?: "attachment" | "plain";
}): Promise<string> {
  const mediaUrl = await resolvePublicFeishuMediaReference(params.mediaUrl);
  const attachmentText = mediaUrl
    ? `${params.mediaLinkStyle === "plain" ? "" : "📎 "}${mediaUrl}`
    : FEISHU_MEDIA_UPLOAD_FAILURE_FALLBACK_TEXT;
  return [params.text?.trim(), attachmentText].filter(Boolean).join("\n\n");
}
