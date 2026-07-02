import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type } from "typebox";
import { createBffFetch, type BffFetchFn } from "./src/internal-http-client.js";

// VC Trader AI: volume_profile.
//
// READ_ONLY per ADR 0078. Global market-data read (S3 OHLCV bars, no
// live/account tables) — rides the gateway-token data cluster like ohlcv_tail
// (Bearer OPENCLAW_GATEWAY_TOKEN; NO workspace/owner bind). Calls the BFF
// `/api/v1/openclaw/data/volume-profile` endpoint and returns the verbatim
// envelope from engine.tools volume_profile (symbol -> instrument, tf ->
// timeframe in the wrapper).

export const VOLUME_PROFILE_TOOL_NAME = "volume_profile";

export type VolumeProfileDeps = {
  fetchImpl?: typeof globalThis.fetch;
  bffFetch?: BffFetchFn;
  /**
   * Per-turn BFF thread id for the CURRENT turn. Forwarded to the BFF as the
   * `X-OpenClaw-Thread` header so it can identify which sub-agent (specialist)
   * is calling and enforce its granted authority. Sourced from the plugin
   * execute context (`context.threadId`).
   */
  threadId?: string;
};

export type VolumeProfileParams = {
  symbol: string;
  tf?: string;
  window?: number;
  n_bins?: number;
  provider?: string;
};

export async function runVolumeProfile(
  params: VolumeProfileParams,
  deps: VolumeProfileDeps = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const bffFetch =
    deps.bffFetch ?? createBffFetch({ fetchImpl: deps.fetchImpl, threadId: deps.threadId });
  return bffFetch(`/api/v1/openclaw/data/volume-profile`, {
    query: {
      symbol: params.symbol,
      tf: params.tf,
      window: params.window !== undefined ? String(params.window) : undefined,
      n_bins: params.n_bins !== undefined ? String(params.n_bins) : undefined,
      provider: params.provider,
    },
    signal,
  });
}

export default defineToolPlugin({
  id: "vctraderai-volume-profile",
  name: "VC Trader AI Volume Profile",
  description: "Read-only volume-profile (price-by-volume histogram) for a symbol + timeframe.",
  tools: (tool) => [
    tool({
      name: VOLUME_PROFILE_TOOL_NAME,
      label: "Volume Profile",
      description:
        "Compute a volume profile (price-by-volume histogram) over a lookback window for the given symbol + timeframe. Global market-data read. READ_ONLY per ADR 0078 - no mutation.",
      parameters: Type.Object({
        symbol: Type.String({ description: "Instrument symbol (e.g. EUR_USD).", minLength: 1 }),
        tf: Type.Optional(
          Type.String({
            description: "Timeframe code (e.g. 1h, 4h, 1d). Defaults server-side to 1h.",
          }),
        ),
        window: Type.Optional(
          Type.Integer({
            description: "Lookback window in bars/days (bounded server-side). Defaults to 90.",
            minimum: 1,
            maximum: 1825,
          }),
        ),
        n_bins: Type.Optional(
          Type.Integer({
            description: "Number of price bins for the histogram. Defaults to 24.",
            minimum: 2,
            maximum: 200,
          }),
        ),
        provider: Type.Optional(Type.String({ description: "Data provider (e.g. dukascopy)." })),
      }),
      async execute(params, _config, context) {
        context.signal?.throwIfAborted();
        return runVolumeProfile(
          params as VolumeProfileParams,
          { threadId: context.threadId },
          context.signal,
        );
      },
    }),
  ],
});
