// Settles channel schema ownership against the schema-defaulted config gateway auto-enable
// actually consumes.
import { validateJsonSchemaValue } from "../plugins/schema-validator.js";
import { normalizeManifestChannelId } from "./channel-claimant-plugins.js";

type ChannelSchemaOwnerEntry = { schema?: Record<string, unknown>; pluginId?: string };

/**
 * Iterates default hydration and ownership planning to STABILITY: schema defaults can make an
 * authored `{}` channel meaningfully configured, one channel's default can flip a second
 * channel's owner, and a flipped owner's schema can REMOVE a default it no longer supplies.
 * Each pass applies defaults with the current owners and replans; each productive pass settles
 * at least one channel, so the authored channel count bounds convergence. Schemas are accepted
 * only at a true fixpoint — built from the very record they hydrate to. When hydration
 * oscillates (a revisited record, or the pass bound expires without equality), no fixpoint
 * exists and the loop settles DETERMINISTICALLY on the authored record's owners — the config
 * the gateway consumes before any default sticks — instead of whichever parity the bound
 * happened to land on.
 */
export function settleDefaultedChannelSchemas(params: {
  /** Authored channel entries whose values the current owners' defaults hydrate. */
  channelsRecord: Record<string, unknown>;
  /** The plan-base channels record the initial schemas were built from. */
  compatChannels: Record<string, unknown>;
  initialSchemas: Map<string, ChannelSchemaOwnerEntry>;
  buildSchemas: (channels: Record<string, unknown>) => Map<string, ChannelSchemaOwnerEntry>;
}): Map<string, ChannelSchemaOwnerEntry> {
  const maxPasses = Object.keys(params.channelsRecord).length + 1;
  let schemas = params.initialSchemas;
  const authoredSource = JSON.stringify(params.compatChannels);
  let schemasSource = authoredSource;
  const seenRecords = new Set([schemasSource]);
  let converged = false;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const defaultedChannels: Record<string, unknown> = { ...params.compatChannels };
    for (const [key, value] of Object.entries(params.channelsRecord)) {
      const trimmed = key.trim();
      const schema = trimmed ? schemas.get(normalizeManifestChannelId(trimmed))?.schema : undefined;
      if (!schema) {
        continue;
      }
      const result = validateJsonSchemaValue({
        schema,
        cacheKey: `channel:${trimmed}`,
        value,
        applyDefaults: true,
      });
      if (result.ok && JSON.stringify(result.value) !== JSON.stringify(value)) {
        defaultedChannels[key] = result.value;
      }
    }
    const hydrated = JSON.stringify(defaultedChannels);
    if (hydrated === schemasSource) {
      converged = true;
      break;
    }
    schemas = params.buildSchemas(defaultedChannels);
    schemasSource = hydrated;
    if (seenRecords.has(hydrated)) {
      // A revisited record proves a cycle: keep iterating and the same records repeat forever.
      break;
    }
    seenRecords.add(hydrated);
  }
  if (!converged && schemasSource !== authoredSource) {
    schemas = params.buildSchemas(params.compatChannels);
  }
  return schemas;
}
