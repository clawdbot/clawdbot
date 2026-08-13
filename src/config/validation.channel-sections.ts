// Validates authored `channels.*` sections: admitted channel identity, one section per
// canonical identity, then the claimant's declared schema.
import { validateJsonSchemaValue } from "../plugins/schema-validator.js";
import { isRecord } from "../utils.js";
import { normalizeManifestChannelId } from "./channel-claimant-plugins.js";
import { resolveChannelConfigKey } from "./channel-configured-shared.js";
import type { ConfigValidationIssue, OpenClawConfig } from "./types.js";

type ChannelSchemaEntry = { schema?: Record<string, unknown>; pluginId?: string };

type ValidateAuthoredChannelSectionsParams = {
  config: OpenClawConfig;
  bundledChannelIds: readonly string[];
  issues: ConfigValidationIssue[];
  warnings: ConfigValidationIssue[];
  /** Channel ids declared by loaded plugins. Called only when an authored key is not yet admitted. */
  ensureClaimedChannelIds: () => readonly string[];
  hasStalePluginEvidenceForUnknownChannel: (channelId: string) => boolean;
  ensureChannelSchemas: () => ReadonlyMap<string, ChannelSchemaEntry>;
  // A getter, not a value: `ensureChannelSchemas()` is what settles convergence, so reading this
  // before that call would capture the pre-settlement default and hydrate a rejected record.
  channelDefaultsConverged: () => boolean;
  replaceChannelConfig: (channelId: string, nextValue: unknown) => void;
  formatChannelConfigIssueMessage: (message: string, pluginId?: string) => string;
};

export function validateAuthoredChannelSections(
  params: ValidateAuthoredChannelSectionsParams,
): void {
  const { config, issues, warnings } = params;
  if (!config.channels || !isRecord(config.channels)) {
    return;
  }
  const allowedChannels = new Set<string>([
    "defaults",
    "modelByChannel",
    ...params.bundledChannelIds,
  ]);
  // First record-shaped section per canonical channel identity, by authored key. Admission folds
  // variant spellings onto one channel while `resolveChannelConfigKey` serves exactly one section
  // per identity, so a second record folding onto a seen identity must reject: validating it
  // would accept credentials or `enabled: false` that activation silently ignores.
  const channelSectionKeyByCanonicalId = new Map<string, string>();
  for (const key of Object.keys(config.channels)) {
    const trimmed = key.trim();
    if (!trimmed) {
      continue;
    }
    if (!allowedChannels.has(trimmed)) {
      for (const channelId of params.ensureClaimedChannelIds()) {
        allowedChannels.add(channelId);
        // A variant manifest spelling (built-in alias, case variant) admits the canonical
        // key too — the runtime normalizes both onto one channel identity.
        allowedChannels.add(normalizeManifestChannelId(channelId));
      }
    }
    if (!allowedChannels.has(trimmed)) {
      const issue = { path: `channels.${trimmed}`, message: `unknown channel id: ${trimmed}` };
      if (params.hasStalePluginEvidenceForUnknownChannel(trimmed)) {
        warnings.push({
          ...issue,
          message: `${issue.message} (stale channel plugin config ignored; run openclaw doctor --fix to remove stale config, or install the plugin)`,
        });
      } else {
        issues.push(issue);
      }
      continue;
    }
    // Only record-shaped sections can shadow each other: the resolver never serves a
    // non-record entry as a channel's config record.
    if (isRecord(config.channels[trimmed])) {
      const canonicalChannelId = normalizeManifestChannelId(trimmed);
      const firstSectionKey = channelSectionKeyByCanonicalId.get(canonicalChannelId);
      if (firstSectionKey !== undefined) {
        // The winning key comes from the activation resolver itself, so the message states
        // exactly which section the runtime reads (exact canonical key first, else the first
        // authored record that folds). The named repair is the doctor merge migration
        // (channels.duplicate-alias-sections-merge), which keeps that same winner.
        const servedKey = resolveChannelConfigKey(config, canonicalChannelId);
        issues.push({
          path: `channels.${trimmed}`,
          message: `duplicate channel config: "${firstSectionKey}" and "${trimmed}" both configure channel "${canonicalChannelId}" and activation reads only channels.${servedKey}; run openclaw doctor --fix to merge these sections`,
        });
        continue;
      }
      channelSectionKeyByCanonicalId.set(canonicalChannelId, trimmed);
    }
    // Schema metadata is keyed by canonical channel identity; the authored key may be a
    // declared variant spelling. Issue paths and the cache key keep the authored spelling.
    const channelSchema = params.ensureChannelSchemas().get(normalizeManifestChannelId(trimmed));
    if (!channelSchema?.schema) {
      continue;
    }
    const result = validateJsonSchemaValue({
      schema: channelSchema.schema,
      cacheKey: `channel:${trimmed}`,
      value: config.channels[trimmed],
      // Apply defaults for AJV schema validation (writeConfigFile persists persistCandidate,
      // not validated.config — #61841) UNLESS ownership settlement did not converge: the
      // settled schemas are the authored record's, and hydrating the returned config would
      // hand the gateway the contradicting record the settlement rejected.
      applyDefaults: params.channelDefaultsConverged(),
    });
    if (!result.ok) {
      for (const error of result.errors) {
        issues.push({
          path:
            error.path === "<root>" ? `channels.${trimmed}` : `channels.${trimmed}.${error.path}`,
          message: params.formatChannelConfigIssueMessage(error.message, channelSchema.pluginId),
          allowedValues: error.allowedValues,
          allowedValuesHiddenCount: error.allowedValuesHiddenCount,
        });
      }
    } else if (params.channelDefaultsConverged()) {
      params.replaceChannelConfig(trimmed, result.value);
    }
  }
}
