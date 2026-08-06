// AG-UI channel config surface.
//
// The AG-UI channel is an inbound HTTP/SSE endpoint with no external
// credentials, so enabling it (`channels.ag-ui.enabled: true`) is all that is
// required to activate its `/v1/ag-ui` routes. This schema also documents the
// streaming/surfacing toggles the channel honors.
//
// Consumed at build time by scripts/generate-bundled-channel-config-metadata.ts
// (the export name must end in "ChannelConfigSchema" and expose a built
// `{ schema, uiHints }` surface) so ag-ui is registered in the bundled-channel
// config metadata. Without this, the gateway does not recognize
// `channels.ag-ui` as a known channel and never activates the plugin.
export const AguiChannelConfigSchema = {
  schema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {
      /** Optional display name for this account. */
      name: { type: "string" },
      /** Whether the AG-UI channel is enabled (activates its HTTP routes). */
      enabled: { type: "boolean" },
      /** Emit block-level updates rather than token deltas to AG-UI clients. */
      blockStreaming: { type: "boolean" },
      /** How assistant text is chunked into TEXT_MESSAGE_CONTENT events. */
      chunkMode: { type: "string" },
      /** Surface model reasoning as AG-UI REASONING_* events. */
      surfaceReasoning: { type: "boolean" },
    },
  },
  uiHints: {},
} as const;
