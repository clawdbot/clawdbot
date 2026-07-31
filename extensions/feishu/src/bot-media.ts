// Feishu inbound media resolution keeps transport downloads and agent-facing text aligned.
import { formatInboundMediaUnavailableText } from "openclaw/plugin-sdk/channel-inbound";
import { resolveFeishuMediaList } from "./bot-content.js";
import type { ClawdbotConfig } from "./bot-runtime-api.js";
import { inlineReplacePostImages } from "./post-image-inline.js";
import type { FeishuMediaInfo } from "./types.js";

type FeishuInboundMediaResult = {
  content: string;
  mediaFailureContent: string;
  mediaList: FeishuMediaInfo[];
};

function createPostImageInliner(
  messageType: string,
  mediaList: FeishuMediaInfo[],
): ((text: string) => string) | undefined {
  if (messageType !== "post") {
    return undefined;
  }
  const pathByKey = new Map<string, string>();
  for (const media of mediaList) {
    if (media.sourceKey && media.path) {
      pathByKey.set(media.sourceKey, media.path);
    }
  }
  return pathByKey.size > 0 ? (text) => inlineReplacePostImages(text, pathByKey) : undefined;
}

export async function resolveFeishuInboundMedia(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  messageType: string;
  rawContent: string;
  content: string;
  maxBytes: number;
  log?: (message: string) => void;
  accountId?: string;
}): Promise<FeishuInboundMediaResult> {
  const mediaList = await resolveFeishuMediaList({
    cfg: params.cfg,
    messageId: params.messageId,
    messageType: params.messageType,
    content: params.rawContent,
    maxBytes: params.maxBytes,
    log: params.log,
    accountId: params.accountId,
  });
  const inlinePostImages = createPostImageInliner(params.messageType, mediaList);
  const content = inlinePostImages?.(params.content) ?? params.content;
  const unavailableCount = mediaList.filter((media) => !media.path).length;
  const mediaFailureContent =
    unavailableCount > 0
      ? formatInboundMediaUnavailableText({
          body: content,
          notice: `[feishu ${unavailableCount > 1 ? `${unavailableCount} attachments` : "attachment"} unavailable]`,
        })
      : content;
  return { content, mediaFailureContent, mediaList };
}
