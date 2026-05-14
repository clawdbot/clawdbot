import { messagingApi } from "@line/bot-sdk";
import { saveMediaStream } from "openclaw/plugin-sdk/media-store";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";

interface DownloadResult {
  path: string;
  contentType?: string;
  size: number;
}

export async function downloadLineMedia(
  messageId: string,
  channelAccessToken: string,
  maxBytes = 10 * 1024 * 1024,
): Promise<DownloadResult> {
  const client = new messagingApi.MessagingApiBlobClient({
    channelAccessToken,
  });

  const response = await client.getMessageContent(messageId);
  const saved = await saveMediaStream(
    response as AsyncIterable<Buffer>,
    undefined,
    "inbound",
    maxBytes,
  );
  logVerbose(`line: persisted media ${messageId} to ${saved.path} (${saved.size} bytes)`);

  return {
    path: saved.path,
    contentType: saved.contentType,
    size: saved.size,
  };
}
