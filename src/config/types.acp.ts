import type { AcpSessionUpdateTag } from "../acp/runtime/types.js";

export type AcpDispatchConfig = {
  /** Master switch for ACP turn dispatch in the reply pipeline. */
  enabled?: boolean;
};

export type AcpStreamConfig = {
  /** Coalescer idle flush window in milliseconds for ACP streamed text. */
  coalesceIdleMs?: number;
  /** Maximum text size per streamed chunk. */
  maxChunkChars?: number;
  /** Suppresses repeated ACP status/tool projection lines within a turn. */
  repeatSuppression?: boolean;
  /** Live streams chunks or waits for terminal event before delivery. */
  deliveryMode?: "live" | "final_only";
  /** Separator inserted before visible text when hidden tool events occurred. */
  hiddenBoundarySeparator?: "none" | "space" | "newline" | "paragraph";
  /** Maximum assistant output characters forwarded per turn. */
  maxOutputChars?: number;
  /** Maximum visible characters for projected session/update lines. */
  maxSessionUpdateChars?: number;
  /**
   * Per-sessionUpdate visibility overrides.
   * Keys not listed here fall back to OpenClaw defaults.
   */
  tagVisibility?: Partial<Record<AcpSessionUpdateTag, boolean>>;
};

export type AcpRuntimeConfig = {
  /** Idle runtime TTL in minutes for ACP session workers. */
  ttlMinutes?: number;
  /** Optional operator install/setup command shown by `/acp install` and `/acp doctor`. */
  installCommand?: string;
};

export type AcpConfig = {
  /** Global ACP runtime gate. */
  enabled?: boolean;
  dispatch?: AcpDispatchConfig;
  /** Backend id registered by ACP runtime plugin (for example: acpx). */
  backend?: string;
  /** Fallback backend ids tried when the primary backend fails with UNAVAILABLE. */
  fallbacks?: string[];
  defaultAgent?: string;
  allowedAgents?: string[];
  maxConcurrentSessions?: number;
  stream?: AcpStreamConfig;
  runtime?: AcpRuntimeConfig;
};
