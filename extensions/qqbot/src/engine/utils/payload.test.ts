import { describe, expect, it } from "vitest";
import {
  decodeCronPayload,
  encodePayloadForCron,
  isCronReminderPayload,
  isMediaPayload,
  parseQQBotPayload,
  type CronReminderPayload,
} from "./payload.js";

describe("engine/utils/payload", () => {
  it("returns original text for non-payload replies", () => {
    const result = parseQQBotPayload("  plain reply  ");

    expect(result).toEqual({ isPayload: false, text: "  plain reply  " });
  });

  it("parses a media payload", () => {
    const result = parseQQBotPayload(
      'QQBOT_PAYLOAD: {"type":"media","mediaType":"image","source":"url","path":"https://example.test/a.png","caption":"cap"}',
    );

    expect(result.isPayload).toBe(true);
    expect(result.payload).toEqual({
      type: "media",
      mediaType: "image",
      source: "url",
      path: "https://example.test/a.png",
      caption: "cap",
    });
    expect(result.payload && isMediaPayload(result.payload)).toBe(true);
  });

  it("rejects malformed or incomplete payloads", () => {
    expect(parseQQBotPayload("QQBOT_PAYLOAD:").error).toBe("Payload body is empty");
    expect(parseQQBotPayload("QQBOT_PAYLOAD: {bad json").error).toContain("Failed to parse JSON");
    expect(parseQQBotPayload('QQBOT_PAYLOAD: {"type":"media","mediaType":"image"}').error).toBe(
      "media payload is missing required fields (mediaType, source, path)",
    );
  });

  it("round-trips cron reminder payloads through the stored format", () => {
    const payload: CronReminderPayload = {
      type: "cron_reminder",
      content: "standup",
      targetType: "group",
      targetAddress: "group-openid",
      originalMessageId: "msg-1",
    };

    const encoded = encodePayloadForCron(payload);
    expect(encoded).toMatch(/^QQBOT_CRON:/);

    const decoded = decodeCronPayload(encoded);
    expect(decoded).toEqual({ isCronPayload: true, payload });
    expect(decoded.payload && isCronReminderPayload(decoded.payload)).toBe(true);
  });

  it("reports cron decode errors without throwing", () => {
    expect(decodeCronPayload("plain")).toEqual({ isCronPayload: false });
    expect(decodeCronPayload("QQBOT_CRON:").error).toBe("Cron payload body is empty");
    expect(decodeCronPayload("QQBOT_CRON:AAA@@@").error).toBe(
      "Failed to decode cron payload: Cron payload body is not valid base64",
    );

    const wrongType = Buffer.from('{"type":"media"}', "utf-8").toString("base64");
    expect(decodeCronPayload(`QQBOT_CRON:${wrongType}`).error).toBe(
      "Expected type cron_reminder but got media",
    );
  });
});
