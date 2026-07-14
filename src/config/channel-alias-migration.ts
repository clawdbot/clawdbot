// Declarative front for channel doctor streaming/dm alias migrations.
import {
  asObjectRecord,
  hasLegacyAccountStreamingAliases,
  hasLegacyStreamingAliases,
  normalizeLegacyChannelAliases,
  resolveLegacyAliasStreamingMode,
  type CompatMutationResult,
  type LegacyStreamingAliasOptions,
  type NormalizeLegacyChannelAccountParams,
} from "./channel-compat-normalization.js";
import type { LegacyConfigRule } from "./legacy.shared.js";
import type { OpenClawConfig } from "./types.openclaw.js";

export type StreamingAliasMode = "off" | "partial" | "block" | "progress";

/**
 * Streaming half of a channel alias-migration spec.
 *
 * TMode widens the migrated `streaming.mode` value set for channels whose
 * nested schema keeps channel-local modes (Matrix adds "quiet"); the generic
 * default keeps the shared four-mode contract for everyone else.
 */
type StreamingAliasSpec<TMode extends string = StreamingAliasMode> = {
  /** Default passed to resolveLegacyAliasStreamingMode for mode-source migration. */
  defaultMode: StreamingAliasMode;
  /** Channel-specific mode resolver override (Slack maps legacy draft stream modes). */
  resolveMode?: (entry: Record<string, unknown>) => TMode;
  /**
   * The channel's runtime default when `streaming` is entirely absent, if it
   * differs from the object-without-mode default (Discord: progress vs off).
   * Pinned when delivery-only aliases materialize the object and no root
   * streaming object exists to seed inherited settings from.
   */
  absentObjectDefault?: StreamingAliasMode;
  /** Channel accepts flat `draftChunk` (Discord, Telegram). */
  includePreviewChunk?: boolean;
  /** Channel accepts flat `nativeStreaming`; returns the resolved nativeTransport (Slack). */
  resolveNativeTransport?: (entry: Record<string, unknown>) => unknown;
  /**
   * Channel has no streaming mode: only delivery flat aliases migrate, and
   * scalar `streaming` values are plain validation errors (iMessage). The
   * detection matcher excludes streamMode/scalar streaming, and the migration
   * only runs when a delivery flat alias exists somewhere in the entry.
   */
  deliveryOnly?: boolean;
};

export type ChannelAliasMigrationSpec<TMode extends string = StreamingAliasMode> = {
  /** Channel id under `channels.<id>`; also the doctor message path prefix. */
  channelId: string;
  streaming: StreamingAliasSpec<TMode>;
  /**
   * Set when the channel's runtime account merge replaces the root `streaming`
   * object wholesale (Discord). Migration then seeds account objects it
   * materializes with the inherited root settings. Leave unset for channels
   * that deep-merge streaming at runtime (Slack, iMessage) — seeding there
   * would freeze inheritance into the account config.
   */
  accountStreamingReplacesRoot?: boolean;
  dm?: {
    root?: boolean;
    accounts?: boolean;
    rootPromoteAllowFrom?: boolean;
  };
  /** Escape hatch for channel-specific per-account migrations (Discord voice.tts). */
  normalizeAccountExtra?: (params: NormalizeLegacyChannelAccountParams) => CompatMutationResult;
};

function buildAliasRuleMessage(params: {
  streaming: StreamingAliasSpec<string>;
  prefix: string;
  root: boolean;
}): string {
  const { streaming, prefix } = params;
  const native = streaming.resolveNativeTransport !== undefined;
  const flat = [
    ...(streaming.deliveryOnly ? [] : ["streamMode", "streaming (scalar)"]),
    "chunkMode",
    "blockStreaming",
    ...(streaming.includePreviewChunk ? ["draftChunk"] : []),
    "blockStreamingCoalesce",
    ...(native ? ["nativeStreaming"] : []),
  ];
  const nested = [
    ...(streaming.deliveryOnly ? [] : ["mode"]),
    "chunkMode",
    ...(streaming.includePreviewChunk ? ["preview.chunk"] : []),
    "block.enabled",
    "block.coalesce",
    ...(native ? ["nativeTransport"] : []),
  ];
  // Root messages spell out the ambiguous scalar `streaming` key with its full
  // path; account messages prefix only the first key. Matches the established
  // hand-written doctor message format.
  const prefixedCount = params.root && !streaming.deliveryOnly ? 2 : 1;
  const keys = flat.map((key, index) => (index < prefixedCount ? `${prefix}.${key}` : key));
  const keyList = `${keys.slice(0, -1).join(", ")}, and ${keys.at(-1)}`;
  return `${keyList} are legacy; use ${prefix}.streaming.{${nested.join(",")}}. Run "openclaw doctor --fix".`;
}

/**
 * Builds the standard channel doctor alias-migration surface from a small spec:
 * detection rules (root + accounts), the per-entry matcher, and the config
 * normalizer. Channels with additional migrations compose around these pieces.
 */
export function defineChannelAliasMigration<TMode extends string = StreamingAliasMode>(
  spec: ChannelAliasMigrationSpec<TMode>,
): {
  legacyConfigRules: LegacyConfigRule[];
  hasLegacyAliases: (value: unknown) => boolean;
  normalizeChannelConfig: (params: { cfg: OpenClawConfig; changes?: string[] }) => {
    config: OpenClawConfig;
    changes: string[];
  };
} {
  const { streaming } = spec;
  const pathPrefix = `channels.${spec.channelId}`;

  const hasLegacyAliases = (value: unknown): boolean => {
    if (streaming.deliveryOnly === true) {
      const entry = asObjectRecord(value);
      return (
        entry !== null &&
        (entry.chunkMode !== undefined ||
          entry.blockStreaming !== undefined ||
          entry.blockStreamingCoalesce !== undefined)
      );
    }
    return hasLegacyStreamingAliases(value, {
      includePreviewChunk: streaming.includePreviewChunk,
      includeNativeTransport: streaming.resolveNativeTransport !== undefined,
    });
  };

  const resolveStreamingOptions = (
    entry: Record<string, unknown>,
  ): LegacyStreamingAliasOptions => ({
    resolvedMode:
      streaming.resolveMode?.(entry) ??
      resolveLegacyAliasStreamingMode(entry, streaming.defaultMode),
    aliasOnlyMode: streaming.absentObjectDefault,
    includePreviewChunk: streaming.includePreviewChunk,
    resolvedNativeTransport: streaming.resolveNativeTransport?.(entry),
  });

  const normalizeChannelConfig = (params: { cfg: OpenClawConfig; changes?: string[] }) => {
    const changes = params.changes ?? [];
    const channels = params.cfg.channels as Record<string, unknown> | undefined;
    const entry = asObjectRecord(channels?.[spec.channelId]);
    if (!entry) {
      return { config: params.cfg, changes };
    }
    if (
      streaming.deliveryOnly === true &&
      !hasLegacyAliases(entry) &&
      !hasLegacyAccountStreamingAliases(entry.accounts, hasLegacyAliases)
    ) {
      return { config: params.cfg, changes };
    }
    const result = normalizeLegacyChannelAliases({
      entry,
      pathPrefix,
      changes,
      normalizeDm: spec.dm?.root,
      rootDmPromoteAllowFrom: spec.dm?.rootPromoteAllowFrom,
      normalizeAccountDm: spec.dm?.accounts,
      seedAccountStreamingFromRoot: spec.accountStreamingReplacesRoot,
      resolveStreamingOptions,
      normalizeAccountExtra: spec.normalizeAccountExtra,
    });
    if (!result.changed) {
      return { config: params.cfg, changes };
    }
    return {
      config: {
        ...params.cfg,
        channels: { ...channels, [spec.channelId]: result.entry },
      } as OpenClawConfig,
      changes,
    };
  };

  return {
    legacyConfigRules: [
      {
        path: ["channels", spec.channelId],
        message: buildAliasRuleMessage({ streaming, prefix: pathPrefix, root: true }),
        match: hasLegacyAliases,
      },
      {
        path: ["channels", spec.channelId, "accounts"],
        message: buildAliasRuleMessage({
          streaming,
          prefix: `${pathPrefix}.accounts.<id>`,
          root: false,
        }),
        match: (value) => hasLegacyAccountStreamingAliases(value, hasLegacyAliases),
      },
    ],
    hasLegacyAliases,
    normalizeChannelConfig,
  };
}
