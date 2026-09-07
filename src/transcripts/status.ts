import {
  TRANSCRIPTS_PAGE_MAX,
  type TranscriptsStatusResult,
} from "../../packages/gateway-protocol/src/schema/transcripts.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { readTranscriptCaptureSnapshot } from "./capture.js";
import { resolveTranscriptsConfig } from "./config.js";
import { readConfiguredTranscriptStarts } from "./configured-start-status.js";
import { manualTranscriptSourceProvider } from "./manual-source.js";
import { projectTranscriptSession, projectTranscriptSource } from "./read.js";
import { assertTranscriptByteCount, assertTranscriptByteLimit } from "./store-read.js";
import { transcriptSessionSelector, type TranscriptsStore } from "./store.js";

type ProviderStatus = TranscriptsStatusResult["providers"][number];

/** Reads lifecycle snapshots only; status must not discover/import providers or probe audio. */
export async function readTranscriptLibraryStatus(
  store: TranscriptsStore,
  cfg: OpenClawConfig,
): Promise<TranscriptsStatusResult> {
  const config = resolveTranscriptsConfig(cfg.transcripts);
  const metadata = getCurrentPluginMetadataSnapshot({
    config: cfg,
    allowWorkspaceScopedSnapshot: true,
  });
  const registry = getActivePluginRegistry();
  const providers = new Map<string, ProviderStatus>();
  const installed = new Map(metadata?.index.plugins.map((plugin) => [plugin.pluginId, plugin]));
  const runtime = new Map(registry?.plugins.map((plugin) => [plugin.id, plugin]));
  for (const plugin of metadata?.plugins ?? []) {
    for (const providerId of plugin.contracts?.transcriptSourceProviders ?? []) {
      const record = runtime.get(plugin.id);
      const enabled = installed.get(plugin.id)?.enabled;
      const descriptor = plugin.transcriptSources?.[providerId];
      providers.set(providerId, {
        providerId,
        pluginId: plugin.id,
        name: descriptor?.name ?? plugin.name ?? providerId,
        ...(descriptor?.autoStart ? { autoStart: descriptor.autoStart } : {}),
        availability:
          record?.status === "error"
            ? "unavailable"
            : record?.enabled === false || enabled === false
              ? "disabled"
              : enabled === true
                ? "enabled"
                : "unknown",
      });
    }
  }
  const registrations = [
    { provider: manualTranscriptSourceProvider, pluginId: undefined },
    ...(registry?.transcriptSourceProviders ?? []),
  ];
  const aliases = new Map<string, string>();
  for (const { provider, pluginId } of registrations) {
    aliases.set(provider.id.toLowerCase(), provider.id);
    for (const alias of provider.aliases ?? []) {
      aliases.set(alias.toLowerCase(), provider.id);
    }
    const record = pluginId ? runtime.get(pluginId) : undefined;
    const existing = providers.get(provider.id);
    providers.set(provider.id, {
      providerId: provider.id,
      ...(pluginId ? { pluginId } : {}),
      name: existing?.name ?? provider.name,
      availability:
        record?.status === "error"
          ? "unavailable"
          : record?.enabled === false || existing?.availability === "disabled"
            ? "disabled"
            : "enabled",
      sourceKinds: [...provider.sourceKinds],
      canStart: Boolean(provider.start),
      canStop: Boolean(provider.stop),
      canImport: Boolean(provider.importTranscript),
      ...(existing?.pluginId === pluginId && existing?.autoStart
        ? { autoStart: existing.autoStart }
        : {}),
    });
  }
  const captures = readTranscriptCaptureSnapshot();
  for (const source of [
    ...config.autoStart,
    ...captures.map((capture) => capture.session.source),
  ]) {
    const providerId = aliases.get(source.providerId.toLowerCase()) ?? source.providerId;
    if (!providers.has(providerId)) {
      providers.set(providerId, {
        providerId,
        name: providerId,
        // A projected runtime inventory cannot establish Gateway-wide absence.
        availability: metadata && metadata.pluginIds === undefined ? "unavailable" : "unknown",
      });
    }
  }
  const allProviders = [...providers.values()].toSorted((a, b) =>
    a.providerId.localeCompare(b.providerId),
  );
  const selectedCaptures = captures
    .toSorted(
      (a, b) =>
        a.session.startedAt.localeCompare(b.session.startedAt) ||
        a.session.sessionId.localeCompare(b.session.sessionId),
    )
    .slice(0, TRANSCRIPTS_PAGE_MAX);
  const active: TranscriptsStatusResult["active"] = [];
  let activeBytes = 0;
  // Project each bounded row before reading the next to avoid retaining private descriptors.
  for (const capture of selectedCaptures) {
    const entry = store.readEntry(transcriptSessionSelector(capture.session));
    if (entry) {
      const projected = projectTranscriptSession(entry, undefined, undefined, captures);
      activeBytes += Buffer.byteLength(JSON.stringify(projected), "utf8");
      assertTranscriptByteCount(activeBytes);
      active.push(projected);
    }
  }
  const configuredStarts = readConfiguredTranscriptStarts(cfg.transcripts);
  const configuredSources: TranscriptsStatusResult["configuredSources"] = config.autoStart
    .slice(0, TRANSCRIPTS_PAGE_MAX)
    .map((configured, index) => {
      const start = configuredStarts?.get(index);
      const requestedId = configured.providerId;
      const providerId = aliases.get(requestedId.toLowerCase()) ?? requestedId;
      const matches = captures.flatMap((capture) => {
        // An exact service attempt distinguishes duplicate entries and full URL
        // requests. Display matching below remains uncertain, never authority.
        if (start) {
          return capture.lifecycleToken === start.lifecycleToken ? [{ capture, exact: true }] : [];
        }
        const source = capture.configuredSource ?? capture.session.source;
        if (
          (capture.providerId.toLowerCase() !== providerId.toLowerCase() &&
            source.providerId.toLowerCase() !== requestedId.toLowerCase()) ||
          (configured.sessionId && configured.sessionId !== capture.session.sessionId)
        ) {
          return [];
        }
        if (
          capture.configuredSource &&
          Boolean(configured.meetingUrl) !== capture.configuredSource.meetingUrl
        ) {
          return [];
        }
        // Configured intent proves omissions. Manual captures cannot establish
        // whether a missing locator was resolved to an unrelated source.
        let exact = !configured.meetingUrl && !source.meetingUrl;
        for (const key of ["accountId", "guildId", "channelId"] as const) {
          if (configured[key] === source[key]) {
            continue;
          }
          if (
            capture.configuredSource ||
            (configured[key] !== undefined && source[key] !== undefined)
          ) {
            return [];
          }
          exact = false;
        }
        return [{ capture, exact }];
      });
      // Capture ownership retains sanitized URLs, not the invitation identity.
      // Even an equal origin/path cannot prove which configured URL started it.
      const activeSelectors = matches
        .filter(({ capture, exact }) => exact && capture.state === "armed")
        .slice(0, TRANSCRIPTS_PAGE_MAX)
        .map(({ capture }) => transcriptSessionSelector(capture.session));
      const provider = providers.get(providerId);
      const { whenOccupied: _whenOccupied, title, sessionId, ...source } = configured;
      const result: TranscriptsStatusResult["configuredSources"][number] = {
        source: projectTranscriptSource(source),
        title,
        sessionId,
        state: !config.enabled
          ? "disabled"
          : activeSelectors.length > 0
            ? "armed"
            : matches.length > 0 ||
                start?.diagnostic === "starting" ||
                start?.diagnostic === "retrying" ||
                (!start && provider?.availability === "unknown")
              ? "unknown"
              : "not-active",
        activeSelectors,
      };
      if (start?.diagnostic) {
        result.startDiagnostic = start.diagnostic;
      }
      return result;
    });
  const latest = store.readLatestEntry();
  const result: TranscriptsStatusResult = {
    enabled: config.enabled,
    providers: allProviders.slice(0, TRANSCRIPTS_PAGE_MAX),
    configuredSources,
    active,
    latestTranscript: latest
      ? projectTranscriptSession(latest, undefined, undefined, captures)
      : null,
    omitted: {
      providers: Math.max(0, allProviders.length - TRANSCRIPTS_PAGE_MAX),
      configuredSources: Math.max(0, config.autoStart.length - TRANSCRIPTS_PAGE_MAX),
      active: Math.max(0, captures.length - TRANSCRIPTS_PAGE_MAX),
    },
  };
  assertTranscriptByteLimit(JSON.stringify(result));
  return result;
}
