import type { Static } from "typebox";
import { asProtocolRecord, isNonEmptyProtocolString } from "./protocol-value-normalization.js";
import type {
  CapabilityConsentErrorDetailsSchema,
  PluginDeclaredSurfaceSchema,
  PluginDeclaredSurfaceWideningSchema,
} from "./schema/plugins.js";

export const PLUGIN_CAPABILITY_CONSENT_REQUIRED = "PLUGIN_CAPABILITY_CONSENT_REQUIRED" as const;

export type CapabilityConsentErrorDetails = Static<typeof CapabilityConsentErrorDetailsSchema>;

type PluginDeclaredSurface = Static<typeof PluginDeclaredSurfaceSchema>;
type PluginDeclaredSurfaceWidening = Static<typeof PluginDeclaredSurfaceWideningSchema>;

const DECLARED_SURFACE_GROUPS = [
  "channels",
  "providers",
  "tools",
  "contracts",
  "hooks",
  "mcpServers",
  "cliCommands",
  "cliBackends",
  "skills",
  "dangerousConfigFlags",
] as const satisfies readonly (keyof PluginDeclaredSurface)[];

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}

function readDeclaredSurfaceWidening(value: unknown): PluginDeclaredSurfaceWidening | undefined {
  const record = asProtocolRecord(value);
  if (!record || !hasOnlyKeys(record, DECLARED_SURFACE_GROUPS)) {
    return undefined;
  }
  const widened: PluginDeclaredSurfaceWidening = {};
  for (const group of DECLARED_SURFACE_GROUPS) {
    const items = record[group];
    if (items === undefined) {
      continue;
    }
    if (!Array.isArray(items) || !items.every(isNonEmptyProtocolString)) {
      return undefined;
    }
    widened[group] = items;
  }
  return widened;
}

export function buildCapabilityConsentErrorDetails(
  details: Omit<CapabilityConsentErrorDetails, "capabilityConsentCode">,
): CapabilityConsentErrorDetails {
  return { capabilityConsentCode: PLUGIN_CAPABILITY_CONSENT_REQUIRED, ...details };
}

/** Keep the startup-path reader registry-free and preserve wire-significant whitespace. */
export function readCapabilityConsentErrorDetails(
  value: unknown,
): CapabilityConsentErrorDetails | undefined {
  const record = asProtocolRecord(value);
  if (
    !record ||
    record.capabilityConsentCode !== PLUGIN_CAPABILITY_CONSENT_REQUIRED ||
    !hasOnlyKeys(record, [
      "capabilityConsentCode",
      "pluginId",
      "reviewToken",
      "widened",
      "acceptedAt",
    ]) ||
    !isNonEmptyProtocolString(record.pluginId) ||
    !isNonEmptyProtocolString(record.reviewToken) ||
    (record.acceptedAt !== undefined && !isNonEmptyProtocolString(record.acceptedAt))
  ) {
    return undefined;
  }
  const widened =
    record.widened === undefined ? undefined : readDeclaredSurfaceWidening(record.widened);
  if (record.widened !== undefined && !widened) {
    return undefined;
  }
  return {
    capabilityConsentCode: PLUGIN_CAPABILITY_CONSENT_REQUIRED,
    pluginId: record.pluginId,
    reviewToken: record.reviewToken,
    ...(widened ? { widened } : {}),
    ...(record.acceptedAt !== undefined ? { acceptedAt: record.acceptedAt } : {}),
  };
}
