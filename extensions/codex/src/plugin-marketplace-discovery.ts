/** Read-only discovery of Codex-owned local, curated, and remote plugin marketplaces. */
import { asOptionalRecord as readRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { v2 } from "./app-server/protocol.js";

const PLUGIN_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_PLUGIN_DESCRIPTION_LENGTH = 160;
const SUPPLEMENTAL_MARKETPLACE_KINDS = [
  "workspace-directory",
  "shared-with-me",
  "created-by-me-remote",
  "vertical",
] as const;

/** Safe, bounded marketplace record returned to operator and model discovery surfaces. */
export type CodexAvailablePlugin = {
  id: string;
  pluginName: string;
  marketplaceName: string;
  description?: string;
  installed: boolean;
  enabled: boolean;
  available: boolean;
  installPolicy?: string;
  authPolicy?: string;
  marketplacePath?: string;
  remotePluginId?: string;
  mustShowInstallationInterstitial?: boolean | null;
  summaryId: string;
};

type CodexPluginDiscoveryResult = {
  plugins: CodexAvailablePlugin[];
  warnings: string[];
};

export type CodexPluginMarketplaceListRequest = (
  params: v2.PluginListParams,
) => Promise<v2.PluginListResponse>;

/** Validates the same identifier segments required by Codex's stable PluginId parser. */
export function parseCodexPluginMarketplaceId(
  value: string,
): { pluginName: string; marketplaceName: string } | undefined {
  const separator = value.lastIndexOf("@");
  if (separator <= 0 || separator === value.length - 1) {
    return undefined;
  }
  const pluginName = value.slice(0, separator);
  const marketplaceName = value.slice(separator + 1);
  return PLUGIN_SEGMENT_PATTERN.test(pluginName) && PLUGIN_SEGMENT_PATTERN.test(marketplaceName)
    ? { pluginName, marketplaceName }
    : undefined;
}

/** Lists local/global first and separately requests workspace, shared, and personal catalogs. */
export async function discoverCodexMarketplacePlugins(params: {
  request: CodexPluginMarketplaceListRequest;
  workspaceDir: string;
}): Promise<CodexPluginDiscoveryResult> {
  const requestParams: v2.PluginListParams = { cwds: [params.workspaceDir] };
  const primary = await params.request(requestParams);
  const warnings: string[] = (primary.marketplaceLoadErrors ?? []).map((error) =>
    boundedCatalogText(error.message),
  );
  const marketplaces = [...primary.marketplaces];

  try {
    const supplemental = await params.request({
      ...requestParams,
      marketplaceKinds: [...SUPPLEMENTAL_MARKETPLACE_KINDS],
    });
    marketplaces.push(...supplemental.marketplaces);
    warnings.push(
      ...(supplemental.marketplaceLoadErrors ?? []).map((error) =>
        boundedCatalogText(error.message),
      ),
    );
  } catch (error) {
    let recoveredSupplementalMarketplace = false;
    for (const kind of SUPPLEMENTAL_MARKETPLACE_KINDS) {
      try {
        const supplemental = await params.request({
          ...requestParams,
          marketplaceKinds: [kind],
        });
        marketplaces.push(...supplemental.marketplaces);
        recoveredSupplementalMarketplace ||= supplemental.marketplaces.length > 0;
        warnings.push(
          ...(supplemental.marketplaceLoadErrors ?? []).map((loadError) =>
            boundedCatalogText(loadError.message),
          ),
        );
      } catch (kindError) {
        warnings.push(
          boundedCatalogText(
            `${kind} marketplace unavailable: ${
              kindError instanceof Error ? kindError.message : String(kindError)
            }`,
          ),
        );
      }
    }
    if (!recoveredSupplementalMarketplace && warnings.length === 0) {
      warnings.push(
        boundedCatalogText(
          `Additional marketplaces could not be listed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
    }
  }

  const discovered = new Map<string, CodexAvailablePlugin>();
  const ambiguous = new Set<string>();
  for (const marketplace of marketplaces) {
    if (!PLUGIN_SEGMENT_PATTERN.test(marketplace.name)) {
      continue;
    }
    for (const summary of marketplace.plugins) {
      const pluginName = pluginSlug(summary, marketplace.name);
      if (!pluginName) {
        continue;
      }
      const id = `${pluginName}@${marketplace.name}`;
      if (ambiguous.has(id)) {
        continue;
      }
      const previous = discovered.get(id);
      const next: CodexAvailablePlugin = {
        id,
        pluginName,
        marketplaceName: marketplace.name,
        installed: summary.installed,
        enabled: summary.enabled,
        available:
          summary.availability !== "DISABLED_BY_ADMIN" && summary.installPolicy !== "NOT_AVAILABLE",
        ...(summary.installPolicy ? { installPolicy: summary.installPolicy } : {}),
        ...(summary.authPolicy ? { authPolicy: summary.authPolicy } : {}),
        ...(marketplace.path ? { marketplacePath: marketplace.path } : {}),
        ...(summary.remotePluginId?.trim()
          ? {
              remotePluginId: summary.remotePluginId.trim(),
              mustShowInstallationInterstitial: summary.mustShowInstallationInterstitial ?? null,
            }
          : {}),
        summaryId: summary.id,
      };
      const description = pluginDescription(summary);
      if (description) {
        next.description = description;
      }
      if (
        previous &&
        (previous.marketplacePath !== next.marketplacePath ||
          previous.remotePluginId !== next.remotePluginId)
      ) {
        discovered.delete(id);
        ambiguous.add(id);
        warnings.push(
          `Multiple discovered plugins share ${id}; installation requires a unique identity.`,
        );
        continue;
      }
      if (!previous) {
        discovered.set(id, next);
      } else {
        const preferred =
          (!previous.installed && next.installed) ||
          (!previous.enabled && next.installed && next.enabled)
            ? next
            : previous;
        discovered.set(id, {
          ...preferred,
          available: previous.available && next.available,
          ...(preferred.remotePluginId
            ? {
                mustShowInstallationInterstitial:
                  previous.mustShowInstallationInterstitial === true ||
                  next.mustShowInstallationInterstitial === true
                    ? true
                    : previous.mustShowInstallationInterstitial === false &&
                        next.mustShowInstallationInterstitial === false
                      ? false
                      : null,
              }
            : {}),
          ...(previous.installPolicy === "NOT_AVAILABLE" || next.installPolicy === "NOT_AVAILABLE"
            ? { installPolicy: "NOT_AVAILABLE" }
            : {}),
        });
      }
    }
  }

  return {
    plugins: [...discovered.values()].toSorted((left, right) => left.id.localeCompare(right.id)),
    warnings,
  };
}

function pluginSlug(summary: v2.PluginSummary, marketplaceName: string): string | undefined {
  const qualified = parseCodexPluginMarketplaceId(summary.id);
  if (qualified?.marketplaceName === marketplaceName) {
    return qualified.pluginName;
  }
  const identitySegment = summary.id.split("/").at(-1);
  if (identitySegment && PLUGIN_SEGMENT_PATTERN.test(identitySegment)) {
    return identitySegment;
  }
  return PLUGIN_SEGMENT_PATTERN.test(summary.name) ? summary.name : undefined;
}

function pluginDescription(summary: v2.PluginSummary): string | undefined {
  const pluginInterface = readRecord(summary.interface);
  const description = pluginInterface?.shortDescription;
  if (typeof description !== "string") {
    return undefined;
  }
  return boundedCatalogText(description) || undefined;
}

function boundedCatalogText(value: string): string {
  let sanitized = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    sanitized +=
      codePoint !== undefined && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
        ? " "
        : character;
  }
  return sanitized.replace(/\s+/g, " ").trim().slice(0, MAX_PLUGIN_DESCRIPTION_LENGTH);
}
