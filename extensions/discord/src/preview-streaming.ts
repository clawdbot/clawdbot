export type DiscordPreviewStreamMode = "off" | "partial" | "block";

function parsePreviewStreamingMode(value: unknown): DiscordPreviewStreamMode | undefined {
  return value === "off" || value === "partial" || value === "block" ? value : undefined;
}

export function resolveDiscordPreviewStreamMode(
  params: {
    streamMode?: unknown;
    streaming?: unknown;
  } = {},
): DiscordPreviewStreamMode {
  const parsedStreaming =
    params.streaming && typeof params.streaming === "object" && !Array.isArray(params.streaming)
      ? parsePreviewStreamingMode(
          (params.streaming as Record<string, unknown>).mode ??
            (params.streaming as Record<string, unknown>).streaming,
        )
      : parsePreviewStreamingMode(params.streaming);
  if (parsedStreaming) {
    return parsedStreaming;
  }

  const legacy = parsePreviewStreamingMode(params.streamMode);
  if (legacy) {
    return legacy;
  }
  if (typeof params.streaming === "boolean") {
    return params.streaming ? "partial" : "off";
  }
  return "off";
}
