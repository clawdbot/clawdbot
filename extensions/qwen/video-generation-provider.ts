// Qwen provider module implements model/runtime integration.
import { buildDashscopeVideoGenerationProvider } from "openclaw/plugin-sdk/video-generation";

const DEFAULT_QWEN_VIDEO_BASE_URL = "https://dashscope-intl.aliyuncs.com";
function resolveQwenVideoBaseUrl(configuredBaseUrl: string | undefined): string {
  const direct = configuredBaseUrl?.trim();
  if (!direct) {
    return DEFAULT_QWEN_VIDEO_BASE_URL;
  }
  try {
    return new URL(direct).toString();
  } catch {
    return DEFAULT_QWEN_VIDEO_BASE_URL;
  }
}

function resolveDashscopeAigcApiBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (
    url.hostname === "coding-intl.dashscope.aliyuncs.com" ||
    url.hostname === "coding.dashscope.aliyuncs.com" ||
    url.hostname === "dashscope-intl.aliyuncs.com" ||
    url.hostname === "dashscope.aliyuncs.com"
  ) {
    return url.origin;
  }
  return baseUrl.replace(/\/+$/u, "");
}

export const qwenVideoGenerationProvider = buildDashscopeVideoGenerationProvider({
  providerId: "qwen",
  label: "Qwen Cloud",
  taskLabel: "Qwen",
  apiKeyLabel: "Qwen",
  defaultBaseUrl: DEFAULT_QWEN_VIDEO_BASE_URL,
  resolveRequestBaseUrl: resolveQwenVideoBaseUrl,
  resolveAigcBaseUrl: resolveDashscopeAigcApiBaseUrl,
});
