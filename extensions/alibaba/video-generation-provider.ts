import { buildDashscopeVideoGenerationProvider } from "openclaw/plugin-sdk/video-generation";

const DEFAULT_ALIBABA_VIDEO_BASE_URL = "https://dashscope-intl.aliyuncs.com";
export const alibabaVideoGenerationProvider = buildDashscopeVideoGenerationProvider({
  providerId: "alibaba",
  label: "Alibaba Model Studio",
  taskLabel: "Alibaba Wan",
  defaultBaseUrl: DEFAULT_ALIBABA_VIDEO_BASE_URL,
});
