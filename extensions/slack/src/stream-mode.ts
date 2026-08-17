// Slack plugin module implements stream mode behavior.
import {
  resolveSlackNativeStreaming,
  resolveSlackStreamingMode,
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
} {
  return {
    mode: resolveSlackStreamingMode(params),
    nativeStreaming: resolveSlackNativeStreaming(params),
  };
}

export function applyAppendOnlyStreamUpdate(params: {
  incoming: string;
  rendered: string;
  source: string;
  /** Joins a divergent incoming value onto the already-rendered text. */
  separator?: string;
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

  // Typical model partials are cumulative prefixes. Rendered must only ever
  // extend: once an appended chunk diverged rendered from source, replacing
  // rendered with the incoming text would drop content the sink already holds.
  if (incoming.startsWith(params.rendered)) {
    return { rendered: incoming, source: incoming, changed: incoming !== params.rendered };
  }
  if (incoming.startsWith(params.source)) {
    const delta = incoming.slice(params.source.length);
    return { rendered: `${params.rendered}${delta}`, source: incoming, changed: delta.length > 0 };
  }

  // Ignore regressive shorter variants of the same stream.
  if (params.source.startsWith(incoming)) {
    return { rendered: params.rendered, source: params.source, changed: false };
  }

  const separator = params.separator ?? (params.rendered.endsWith("\n") ? "" : "\n");
  return {
    rendered: `${params.rendered}${separator}${incoming}`,
    source: incoming,
    changed: true,
  };
}
