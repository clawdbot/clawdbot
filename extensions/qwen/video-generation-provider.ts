// Qwen provider module implements model/runtime integration.
import { buildDashscopeVideoGenerationProvider } from "openclaw/plugin-sdk/video-generation";
import { isQwenCodingPlanBaseUrl } from "./models.js";

const DEFAULT_QWEN_VIDEO_BASE_URL = "https://dashscope-intl.aliyuncs.com";

function isQwenVideoEndpointSupported(baseUrl: string | undefined): boolean {
  if (isQwenCodingPlanBaseUrl(baseUrl)) {
    return false;
  }
  try {
    const hostname = new URL(baseUrl ?? DEFAULT_QWEN_VIDEO_BASE_URL).hostname;
    return !/^token-plan\..+\.maas\.aliyuncs\.com\.?$/iu.test(hostname);
  } catch {
    return true;
  }
}

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
  const hostname = url.hostname.toLowerCase().replace(/\.+$/u, "");
  if (
    /(?:^|\.)dashscope(?:-[^.]+)?\.aliyuncs\.com$/u.test(hostname) ||
    hostname.endsWith(".maas.aliyuncs.com")
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
  credentialPolicy: {
    // Coding/Token Plan subscriptions use the same provider id but do not include Wan models.
    acceptsApiKey: (apiKey) => !apiKey.trim().startsWith("sk-sp-"),
    acceptsBaseUrl: isQwenVideoEndpointSupported,
    unsupportedMessage:
      "Qwen Wan video generation requires a Standard DashScope endpoint and a same-region Standard API key; Coding Plan and Token Plan credentials are not supported.",
  },
});
