import { runZca } from "./zca.js";

export type ZalouserSendOptions = {
  profile?: string;
  mediaUrl?: string;
  caption?: string;
  isGroup?: boolean;
};

export type ZalouserSendResult = {
  ok: boolean;
  messageId?: string;
  error?: string;
};

export async function sendMessageZalouser(
  threadId: string,
  text: string,
  options: ZalouserSendOptions = {},
): Promise<ZalouserSendResult> {
  const profile = options.profile || process.env.ZCA_PROFILE || "default";

  if (!threadId?.trim()) {
    return { ok: false, error: "No threadId provided" };
  }

  // Handle media sending
  if (options.mediaUrl) {
    return sendMediaZalouser(threadId, options.mediaUrl, {
      ...options,
      caption: text || options.caption,
    });
  }

  // Send text message
  const args = ["msg", "send", threadId.trim(), text.slice(0, 2000)];
  if (options.isGroup) args.push("-g");

  try {
    const result = await runZca(args, { profile });

    if (result.ok) {
      return { ok: true, messageId: extractMessageId(result.stdout) };
    }

    return { ok: false, error: result.stderr || "Failed to send message" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function sendMediaZalouser(
  threadId: string,
  mediaUrl: string,
  options: ZalouserSendOptions = {},
): Promise<ZalouserSendResult> {
  const profile = options.profile || process.env.ZCA_PROFILE || "default";

  if (!threadId?.trim()) {
    return { ok: false, error: "No threadId provided" };
  }

  if (!mediaUrl?.trim()) {
    return { ok: false, error: "No media URL provided" };
  }

  // Determine media type from URL
  const lowerUrl = mediaUrl.toLowerCase();
  let command: string;
  if (lowerUrl.match(/\.(mp4|mov|avi|webm)$/)) {
    command = "video";
  } else if (lowerUrl.match(/\.(mp3|wav|ogg|m4a)$/)) {
    command = "voice";
  } else {
    command = "image";
  }

  const args = ["msg", command, threadId.trim(), "-u", mediaUrl.trim()];
  if (options.caption) {
    args.push("-m", options.caption.slice(0, 2000));
  }
  if (options.isGroup) args.push("-g");

  try {
    const result = await runZca(args, { profile });

    if (result.ok) {
      return { ok: true, messageId: extractMessageId(result.stdout) };
    }

    return { ok: false, error: result.stderr || `Failed to send ${command}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function sendImageZalouser(
  threadId: string,
  imageUrl: string,
  options: ZalouserSendOptions = {},
): Promise<ZalouserSendResult> {
  const profile = options.profile || process.env.ZCA_PROFILE || "default";
  const args = ["msg", "image", threadId.trim(), "-u", imageUrl.trim()];
  if (options.caption) {
    args.push("-m", options.caption.slice(0, 2000));
  }
  if (options.isGroup) args.push("-g");

  try {
    const result = await runZca(args, { profile });
    if (result.ok) {
      return { ok: true, messageId: extractMessageId(result.stdout) };
    }
    return { ok: false, error: result.stderr || "Failed to send image" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function sendLinkZalouser(
  threadId: string,
  url: string,
  options: ZalouserSendOptions = {},
): Promise<ZalouserSendResult> {
  const profile = options.profile || process.env.ZCA_PROFILE || "default";
  const args = ["msg", "link", threadId.trim(), url.trim()];
  if (options.isGroup) args.push("-g");

  try {
    const result = await runZca(args, { profile });
    if (result.ok) {
      return { ok: true, messageId: extractMessageId(result.stdout) };
    }
    return { ok: false, error: result.stderr || "Failed to send link" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function extractMessageId(stdout: string): string | undefined {
  // Try to extract message ID from output
  const match = stdout.match(/message[_\s]?id[:\s]+(\S+)/i);
  if (match) return match[1];
  // Return first word if it looks like an ID
  const firstWord = stdout.trim().split(/\s+/)[0];
  if (firstWord && /^[a-zA-Z0-9_-]+$/.test(firstWord)) {
    return firstWord;
  }
  return undefined;
}
