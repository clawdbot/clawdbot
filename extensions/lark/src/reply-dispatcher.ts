import type { ReplyDispatcher, ClawdbotConfig } from "clawdbot/plugin-sdk";
import { larkOutbound } from "./send.js";

type PayloadBody = string | { text?: string } | null | undefined;

function extractText(body: PayloadBody): string {
  if (typeof body === "string") return body;
  if (body && typeof body === "object" && "text" in body) {
    return body.text ?? "";
  }
  return "";
}

export function createLarkReplyDispatcher(opts: {
  cfg: ClawdbotConfig;
  channelId: string;
}): ReplyDispatcher {
  return {
    dispatch: async (payload) => {
      const text = extractText(payload.body as PayloadBody);

      if (!text) {
        return { id: "skipped", ts: Date.now() };
      }

      const result = await larkOutbound.sendText({
        cfg: opts.cfg,
        to: opts.channelId,
        text,
      });

      return { id: result.id ?? "", ts: result.ts ?? Date.now() };
    },
  };
}
