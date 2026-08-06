// Feishu JSON response helpers shared by credentialed API paths.
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";

/** Feishu control-plane JSON responses are tiny; 16 MiB leaves ample headroom. */
export const FEISHU_JSON_MAX_BYTES = 16 * 1024 * 1024;

export async function readFeishuJsonResponse<T>(
  response: Response,
  label = "feishu.api",
): Promise<T> {
  return readProviderJsonResponse<T>(response, label, { maxBytes: FEISHU_JSON_MAX_BYTES });
}
