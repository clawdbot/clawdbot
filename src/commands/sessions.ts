import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
/**
 * Session listing command.
 *
 * It loads one or more agent session stores, enriches rows with model/runtime
 * metadata, and emits JSON or terminal tables.
 */
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { getTerminalTableWidth, renderTable } from "../../packages/terminal-core/src/table.js";
import { colorize, isRich, theme } from "../../packages/terminal-core/src/theme.js";
import { readAcpSessionMetaBatch } from "../acp/runtime/session-meta.js";
import { resolveModelAgentRuntimeMetadata } from "../agents/agent-runtime-metadata.js";
import { resolveAuthoredModelContextTokens } from "../agents/context-resolution.js";
import { DEFAULT_CONTEXT_TOKENS } from "../agents/defaults.js";
import {
  prepareCliProviderClassifier,
  type CliProviderClassifier,
} from "../agents/model-selection.js";
import { resolveRuntimePolicySessionKey } from "../auto-reply/reply/runtime-policy-session-key.js";
import { normalizeChatType } from "../channels/chat-type.js";
import { ExpectedCliError } from "../cli/failure-output.js";
import { getRuntimeConfig } from "../config/config.js";
import { resolveFreshSessionTotalTokens, resolveSessionTotalTokens } from "../config/sessions.js";
import { resolveProjectedSessionContextTokens } from "../config/sessions/context-token-provenance.js";
import { listSessionEntriesReadOnly } from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveStoredSessionKeyForAgentStore } from "../gateway/session-store-key.js";
import { info } from "../globals.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { classifySessionKind, type SessionKind } from "../sessions/classify-session-kind.js";
import { isAcpSessionKey } from "../sessions/session-key-utils.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { resolveAgentRuntimeLabel } from "../status/agent-runtime-label.js";
import {
  deliveryContextFromSession,
  sessionDeliveryOrigin,
} from "../utils/delivery-context.shared.js";
import { resolveSessionStoreTargetsOrExit } from "./session-store-targets.js";
import {
  resolveSessionDisplayModelRef,
  resolveSessionDisplayDefaults,
} from "./sessions-display-model.js";
import {
  formatSessionAgeCell,
  formatSessionFlagsCell,
  formatSessionKeyCell,
  formatSessionModelCell,
  type SessionDisplayRow,
  toSessionDisplayRow,
} from "./sessions-table.js";

type SessionRow = SessionDisplayRow & {
  agentId: string;
  kind: SessionKind;
  agentRuntime: ReturnType<typeof resolveModelAgentRuntimeMetadata>;
  runtimeLabel: string;
  /** Carry the prepared identity into JSON/table emission without re-resolving plugin metadata. */
  displayModelRef: { provider: string; model: string };
  /**
   * True only when the session has persisted ACP runtime metadata. Key-shape
   * alone is not sufficient because ACP bridge sessions (translator.ts) may
   * use ACP-shaped keys without ever writing `SessionAcpMeta` — those use the
   * normal configured model and must not be overlaid with the acpx sentinel.
   */
  acpRuntime: boolean;
};

const DEFAULT_SESSIONS_LIMIT = 100;
const TOP_N_SELECTION_LIMIT = 200;
const contextLookupRuntimeLoader = createLazyImportLoader(() => import("../agents/context.js"));

const formatKTokens = (value: number) => `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`;

/** True ACP sessions use the child runtime's model, not the configured fallback. */
function applyAcpModelOverlayIfNeeded(
  modelRef: { provider: string; model: string },
  sessionKey: string,
  acpRuntime: boolean,
): { provider: string; model: string } {
  if (!acpRuntime || !isAcpSessionKey(sessionKey)) {
    return modelRef;
  }
  const agentId = parseAgentSessionKey(sessionKey)?.agentId ?? "acp";
  return { provider: "acpx", model: `${agentId}-acp` };
}

function compareSessionRowsByUpdatedAt(a: SessionRow, b: SessionRow): number {
  return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
}

function selectNewestSessionRows(rows: SessionRow[], limit: number | undefined): SessionRow[] {
  if (limit === undefined) {
    return rows.toSorted(compareSessionRowsByUpdatedAt);
  }
  if (limit > TOP_N_SELECTION_LIMIT) {
    return rows.toSorted(compareSessionRowsByUpdatedAt).slice(0, limit);
  }
  // For small limits, keep only the top N rows without sorting the full store;
  // large limits use the simpler full sort above.
  const selected: SessionRow[] = [];
  for (const row of rows) {
    const insertAt = selected.findIndex(
      (candidate) => compareSessionRowsByUpdatedAt(row, candidate) < 0,
    );
    if (insertAt >= 0) {
      selected.splice(insertAt, 0, row);
      if (selected.length > limit) {
        selected.pop();
      }
    } else if (selected.length < limit) {
      selected.push(row);
    }
  }
  return selected;
}

function parseSessionsLimit(value: string | number | undefined): number | undefined | null {
  if (value === undefined) {
    return DEFAULT_SESSIONS_LIMIT;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.toLowerCase() === "all") {
      return undefined;
    }
    if (!/^\d+$/.test(trimmed)) {
      return null;
    }
    return parseStrictPositiveInteger(trimmed) ?? null;
  }
  return Number.isInteger(value) && value > 0 ? value : null;
}

const colorByPct = (label: string, pct: number | null, rich: boolean) => {
  if (!rich || pct === null) {
    return label;
  }
  if (pct >= 95) {
    return theme.error(label);
  }
  if (pct >= 80) {
    return theme.warn(label);
  }
  if (pct >= 60) {
    return theme.success(label);
  }
  return theme.muted(label);
};

// Matches `openclaw status` semantics: show the recorded total whenever one
// exists, and withhold only the percentage when freshness provenance is missing.
const formatTokensCell = (
  total: number | undefined,
  freshTotal: number | undefined,
  contextTokens: number | null,
  rich: boolean,
) => {
  const ctxLabel = contextTokens ? formatKTokens(contextTokens) : "?";
  if (total === undefined) {
    const label = `unknown/${ctxLabel} (?%)`;
    return rich ? theme.muted(label) : label;
  }
  const pct =
    contextTokens && freshTotal !== undefined
      ? Math.min(999, Math.round((freshTotal / contextTokens) * 100))
      : null;
  const label = `${formatKTokens(total)}/${ctxLabel} (${pct ?? "?"}%)`;
  return colorByPct(label, pct, rich);
};

const formatKindCell = (kind: SessionRow["kind"], rich: boolean) => {
  if (!rich) {
    return kind;
  }
  if (kind === "group") {
    return theme.accentBright(kind);
  }
  if (kind === "global") {
    return theme.warn(kind);
  }
  if (kind === "direct") {
    return theme.accent(kind);
  }
  return theme.muted(kind);
};

function resolveSessionRuntimeLabel(params: {
  cfg: OpenClawConfig;
  entry: SessionEntry;
  agentRuntime: ReturnType<typeof resolveModelAgentRuntimeMetadata>;
  modelProvider: string;
  classifyCliProvider: CliProviderClassifier;
}): string {
  const id = normalizeOptionalLowercaseString(params.agentRuntime.id);
  const resolvedHarness = id && id !== "openclaw" && id !== "auto" ? id : undefined;
  return resolveAgentRuntimeLabel({
    config: params.cfg,
    sessionEntry: params.entry,
    resolvedHarness,
    fallbackProvider: params.modelProvider,
    classifyCliProvider: params.classifyCliProvider,
  });
}

function resolveSessionStoreDisplayPath(target: { agentId: string; storePath: string }): string {
  return resolveSqliteTargetFromSessionStorePath(target.storePath, {
    agentId: target.agentId,
  }).path;
}

function toJsonSessionRow(row: SessionRow): Omit<SessionRow, "displayModelRef" | "runtimeLabel"> {
  const { displayModelRef, runtimeLabel, ...jsonRow } = row;
  void displayModelRef;
  void runtimeLabel;
  return jsonRow;
}

function stripChannelRecipientPrefix(
  value: string | undefined,
  channel: string | undefined,
): string | undefined {
  const raw = normalizeOptionalString(value);
  const normalizedChannel = normalizeOptionalLowercaseString(channel);
  if (!raw || !normalizedChannel) {
    return raw;
  }
  const prefix = `${normalizedChannel}:`;
  if (!raw.toLowerCase().startsWith(prefix)) {
    return raw;
  }
  const stripped = raw.slice(prefix.length);
  const topicMarkerIndex = stripped.toLowerCase().indexOf(":topic:");
  // Topic suffixes are routing detail, not the peer id used by runtime-policy
  // session-key display.
  return topicMarkerIndex >= 0 ? stripped.slice(0, topicMarkerIndex) : stripped;
}

function resolveDisplayRuntimePolicySessionKey(params: {
  agentId: string;
  cfg: OpenClawConfig;
  key: string;
  entry: SessionEntry;
}): string | undefined {
  const { cfg, entry, key } = params;
  const origin = sessionDeliveryOrigin(entry);
  const deliveryContext = deliveryContextFromSession(entry);
  const chatType = normalizeChatType(origin?.chatType ?? entry.chatType);
  if (chatType !== "direct") {
    return undefined;
  }

  const channel = normalizeOptionalString(
    origin?.provider ?? deliveryContext?.channel ?? origin?.surface,
  );
  const to = normalizeOptionalString(origin?.to ?? deliveryContext?.to);
  const from = normalizeOptionalString(origin?.from);
  const nativeDirectUserId = normalizeOptionalString(origin?.nativeDirectUserId);
  const peerId =
    nativeDirectUserId ??
    stripChannelRecipientPrefix(to, channel) ??
    stripChannelRecipientPrefix(from, channel);

  // Direct-message runtime policy can route by native user id, stripped
  // recipient, or sender; expose the derived key when it differs from the row.
  const runtimePolicySessionKey = resolveRuntimePolicySessionKey({
    agentId: params.agentId,
    cfg,
    sessionKey: key,
    ctx: {
      SessionKey: key,
      AgentId: params.agentId,
      Provider: channel,
      Surface: normalizeOptionalString(origin?.surface),
      AccountId: normalizeOptionalString(origin?.accountId ?? deliveryContext?.accountId),
      ChatType: chatType,
      NativeDirectUserId: nativeDirectUserId,
      SenderId: peerId,
      OriginatingTo: to,
      From: from,
      To: to,
    },
  });

  return runtimePolicySessionKey && runtimePolicySessionKey !== key
    ? runtimePolicySessionKey
    : undefined;
}

/** Lists sessions across selected stores with optional JSON output. */
export async function sessionsCommand(
  opts: {
    json?: boolean;
    store?: string;
    active?: string;
    agent?: string;
    allAgents?: boolean;
    limit?: string | number;
  },
  runtime: RuntimeEnv,
) {
  const aggregateAgents = opts.allAgents === true;
  const cfg = getRuntimeConfig();
  const displayDefaults = resolveSessionDisplayDefaults(cfg);
  const { lookupContextTokens, resolveContextTokensForModel } =
    await contextLookupRuntimeLoader.load();
  const configContextTokens =
    lookupContextTokens(displayDefaults.model, { allowAsyncLoad: false }) ?? DEFAULT_CONTEXT_TOKENS;
  const targets = resolveSessionStoreTargetsOrExit({
    cfg,
    opts: {
      store: opts.store,
      agent: opts.agent,
      allAgents: opts.allAgents,
    },
    runtime,
    json: opts.json,
  });
  if (!targets) {
    return;
  }

  let activeMinutes: number | undefined;
  if (opts.active !== undefined) {
    const parsed = parseStrictPositiveInteger(opts.active);
    if (parsed === undefined) {
      const message = "--active must be a positive number of minutes, for example --active 30.";
      throw new ExpectedCliError({ message, humanOutput: message, machineOutput: message });
    }
    activeMinutes = parsed;
  }

  const limit = parseSessionsLimit(opts.limit);
  if (limit === null) {
    const message = '--limit must be a positive integer or "all", for example --limit 25.';
    throw new ExpectedCliError({ message, humanOutput: message, machineOutput: message });
  }

  const classifyCliProvider = prepareCliProviderClassifier(cfg);
  const activeSince = activeMinutes === undefined ? undefined : Date.now() - activeMinutes * 60_000;
  const sessionEntries = targets.flatMap((target) => {
    return listSessionEntriesReadOnly({
      agentId: target.agentId,
      storePath: target.storePath,
      projection: "list",
    })
      .filter(
        ({ entry }) =>
          activeSince === undefined ||
          (typeof entry.updatedAt === "number" && entry.updatedAt >= activeSince),
      )
      .map(({ sessionKey, entry }) => {
        const row = toSessionDisplayRow(sessionKey, entry);
        const agentId = parseAgentSessionKey(row.key)?.agentId ?? target.agentId;
        const acpSessionKey = resolveStoredSessionKeyForAgentStore({
          cfg,
          agentId,
          sessionKey: row.key,
        });
        return { acpSessionKey, agentId, entry, row };
      });
  });
  const acpSessionMetaByEntry = readAcpSessionMetaBatch({
    entries: sessionEntries.map(({ acpSessionKey, entry }) => ({
      sessionKey: acpSessionKey,
      entry,
    })),
  });
  const allRows = sessionEntries.map(({ acpSessionKey, agentId, entry, row }) => {
    const acpMeta = acpSessionMetaByEntry.get(entry);
    const acpRuntime = acpMeta != null;
    // ACP rows need stored-key metadata before model/runtime resolution so
    // bridge sessions and true ACP runtime sessions display differently.
    const modelRef = applyAcpModelOverlayIfNeeded(
      resolveSessionDisplayModelRef(cfg, row, classifyCliProvider, agentId),
      acpSessionKey,
      acpRuntime,
    );
    const agentRuntime = resolveModelAgentRuntimeMetadata({
      cfg,
      agentId,
      sessionEntry: entry,
      provider: modelRef.provider,
      model: modelRef.model,
      sessionKey: acpSessionKey,
      acpRuntime,
      acpBackend: acpMeta?.backend,
    });
    const hasPersistedContextTokens =
      typeof entry.contextTokens === "number" && entry.contextTokens > 0;
    // CLI-backed rows can store a canonical display provider that does not own
    // the runtime's context policy, so retain their model-only offline fallback.
    const usesCliContextFallback =
      !hasPersistedContextTokens && classifyCliProvider(agentRuntime.id);
    const resolvedContextTokens = usesCliContextFallback
      ? lookupContextTokens(modelRef.model, { allowAsyncLoad: false })
      : resolveContextTokensForModel({
          cfg,
          provider: modelRef.provider,
          model: modelRef.model,
          allowAsyncLoad: false,
        });
    const contextTokens = resolveProjectedSessionContextTokens({
      entry,
      provider: modelRef.provider,
      model: modelRef.model,
      agentHarnessId: agentRuntime.id,
      resolvedContextTokens,
      authoredContextTokens: resolveAuthoredModelContextTokens({
        cfg,
        provider: modelRef.provider,
        model: modelRef.model,
      }),
    });
    return Object.assign({}, row, {
      agentId,
      acpRuntime,
      agentRuntime,
      contextTokens,
      displayModelRef: modelRef,
      kind: classifySessionKind(row.key, entry),
      runtimePolicySessionKey: resolveDisplayRuntimePolicySessionKey({
        agentId,
        cfg,
        key: row.key,
        entry,
      }),
      runtimeLabel: resolveSessionRuntimeLabel({
        cfg,
        entry,
        agentRuntime,
        modelProvider: modelRef.provider,
        classifyCliProvider,
      }),
    });
  });
  const totalCount = allRows.length;
  const rows = selectNewestSessionRows(allRows, limit);
  const hasMore = rows.length < totalCount;

  if (opts.json) {
    const multi = targets.length > 1;
    const aggregate = aggregateAgents || multi;
    writeRuntimeJson(runtime, {
      path: aggregate || !targets[0] ? null : resolveSessionStoreDisplayPath(targets[0]),
      stores: aggregate
        ? targets.map((target) => ({
            agentId: target.agentId,
            path: resolveSessionStoreDisplayPath(target),
          }))
        : undefined,
      allAgents: aggregateAgents ? true : undefined,
      count: rows.length,
      totalCount,
      limitApplied: limit ?? null,
      hasMore,
      activeMinutes: activeMinutes ?? null,
      sessions: rows.map((row) => {
        const r = toJsonSessionRow(row);
        const modelRef = row.displayModelRef;
        return {
          ...r,
          totalTokens: resolveSessionTotalTokens(r) ?? null,
          totalTokensFresh: resolveFreshSessionTotalTokens(r) !== undefined,
          contextTokens: r.contextTokens ?? configContextTokens ?? null,
          modelProvider: modelRef.provider,
          model: modelRef.model,
        };
      }),
    });
    return;
  }

  const primaryTarget = targets[0];
  if (primaryTarget && targets.length === 1 && !aggregateAgents) {
    runtime.log(info(`Session store: ${resolveSessionStoreDisplayPath(primaryTarget)}`));
  } else {
    runtime.log(
      info(`Session stores: ${targets.length} (${targets.map((t) => t.agentId).join(", ")})`),
    );
  }
  runtime.log(
    info(
      hasMore && limit !== undefined
        ? `Sessions listed: ${rows.length} of ${totalCount} (limit ${limit})`
        : `Sessions listed: ${rows.length}`,
    ),
  );
  if (activeMinutes) {
    runtime.log(info(`Filtered to last ${activeMinutes} minute(s)`));
  }
  if (rows.length === 0) {
    runtime.log("No sessions found.");
    return;
  }

  const rich = isRich();
  const showAgentColumn = aggregateAgents || targets.length > 1;
  runtime.log(
    renderTable({
      width: getTerminalTableWidth(),
      columns: [
        ...(showAgentColumn ? [{ key: "agent", header: "Agent" }] : []),
        { key: "kind", header: "Kind" },
        { key: "key", header: "Key" },
        { key: "age", header: "Age" },
        { key: "model", header: "Model" },
        { key: "runtime", header: "Runtime" },
        { key: "tokens", header: "Tokens (ctx %)" },
        { key: "flags", header: "Flags", flex: true },
      ].map((column) =>
        Object.assign(column, { header: colorize(rich, theme.heading, column.header) }),
      ),
      rows: rows.map((row) => ({
        agent: colorize(rich, theme.accentBright, sanitizeTerminalText(row.agentId)),
        kind: formatKindCell(row.kind, rich),
        key: formatSessionKeyCell(row.key, rich),
        age: formatSessionAgeCell(row.updatedAt, rich),
        model: formatSessionModelCell(row.displayModelRef.model, rich),
        runtime: colorize(rich, theme.info, sanitizeTerminalText(row.runtimeLabel)),
        tokens: formatTokensCell(
          resolveSessionTotalTokens(row),
          resolveFreshSessionTotalTokens(row),
          row.contextTokens ?? configContextTokens,
          rich,
        ),
        flags: formatSessionFlagsCell(row, rich),
      })),
    }).trimEnd(),
  );
}
