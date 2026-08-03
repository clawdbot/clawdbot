// Slack plugin module implements stream mode behavior.
import {
  mapStreamingModeToSlackLegacyDraftStreamMode,
  resolveSlackNativeStreaming,
  resolveSlackStreamingMode,
  type SlackLegacyDraftStreamMode,
  type StreamingMode,
} from "./streaming-compat.js";

type SlackStreamingMode = StreamingMode;

export function resolveSlackStreamingConfig(params: {
  streaming?: unknown;
  streamMode?: unknown;
  nativeStreaming?: unknown;
}): {
  mode: SlackStreamingMode;
  nativeStreaming: boolean;
  draftMode: SlackLegacyDraftStreamMode;
} {
  const mode = resolveSlackStreamingMode(params);
  const nativeStreaming = resolveSlackNativeStreaming(params);
  return {
    mode,
    nativeStreaming,
    draftMode: mapStreamingModeToSlackLegacyDraftStreamMode(mode),
  };
}

export function applyAppendOnlyStreamUpdate(params: {
  incoming: string;
  rendered: string;
  source: string;
}): { rendered: string; source: string; changed: boolean } {
  const incoming = params.incoming.trimEnd();
  if (!incoming) {
    return { rendered: params.rendered, source: params.source, changed: false };
  }
  if (!params.rendered) {
    return { rendered: incoming, source: incoming, changed: true };
  }
  if (incoming === params.source) {
    return { rendered: params.rendered, source: params.source, changed: false };
  }

  // Typical model partials are cumulative prefixes.
  if (incoming.startsWith(params.source) || incoming.startsWith(params.rendered)) {
    return { rendered: incoming, source: incoming, changed: incoming !== params.rendered };
  }

  // Ignore regressive shorter variants of the same stream.
  if (params.source.startsWith(incoming)) {
    return { rendered: params.rendered, source: params.source, changed: false };
  }

  const separator = params.rendered.endsWith("\n") ? "" : "\n";
  return {
    rendered: `${params.rendered}${separator}${incoming}`,
    source: incoming,
    changed: true,
  };
}
