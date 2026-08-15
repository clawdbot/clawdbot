import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const FEISHU_SEND_RATE_LIMIT_CODES = new Set([230020, 11232]);

export function getFeishuSendRateLimitCode(error: unknown): number | undefined {
  if (!isRecord(error)) {
    return undefined;
  }
  const response = isRecord(error.response) ? error.response : undefined;
  if (response?.status === 429) {
    return 429;
  }
  const data = isRecord(response?.data) ? response.data : undefined;
  const code = data?.code;
  return typeof code === "number" && FEISHU_SEND_RATE_LIMIT_CODES.has(code) ? code : undefined;
}

export function getFeishuSendRateLimitCodeFromResponse(response: unknown): number | undefined {
  if (!isRecord(response)) {
    return undefined;
  }
  const code = response.code;
  return typeof code === "number" && FEISHU_SEND_RATE_LIMIT_CODES.has(code) ? code : undefined;
}
