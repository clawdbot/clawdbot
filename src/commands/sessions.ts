import { resolveModelAgentRuntimeMetadata } from "../agents/agent-runtime-metadata.js";
import { DEFAULT_CONTEXT_TOKENS } from "../agents/defaults.js";
import { getRuntimeConfig } from "../config/config.js";
import { loadSessionStore, resolveSessionTotalTokens } from "../config/sessions.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { info } from "../globals.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { classifySessionKind, type SessionKind } from "../sessions/classify-session-kind.js";
import { isAcpSessionKey } from "../sessions/session-key-utils.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { resolveAgentRuntimeLabel } from "../status/agent-runtime-label.js";
import { isRich, theme } from "../terminal/theme.js";
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
  SESSION_AGE_PAD,
  SESSION_KEY_PAD,
  SESSION_MODEL_PAD,
  type SessionDisplayRow,
  toSessionDisplayRow,
} from "./sessions-table.js";

type SessionRow = SessionDisplayRow & {
  agentId: string;
  kind: SessionKind;
  agentRuntime: ReturnType<typeof resolveModelAgentRuntimeMetadata>;
  runtimeLabel: string;
  /**
   * True only when the session entry has persisted ACP runtime metadata
   * (`entry.acp` is present). Key-shape alone is not sufficient because ACP
   * bridge sessions (translator.ts) may use ACP-shaped keys without ever
   * writing `SessionAcpMeta` — those use the normal configured model and must
   * not be overlaid with the acpx sentinel.
   */
  acpRuntime: boolean;
};

const AGENT_PAD = 10;
const KIND_PAD = 11; // "spawn-child".length — longest kind label
const RUNTIME_PAD = 18;
const TOKENS_PAD = 20;
const DEFAULT_SESSIONS_LIMIT = 100;
const TOP_N_SELECTION_LIMIT = 200;
const contextLookupRuntimeLoader = createLazyImportLoader(() => import("../agents/context.js"));

const formatKTokens = (value: number) => `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`;

/**
 * Inline ACP model overlay — catalog #20.
 *
 * When a session ran via the ACP control plane (e.g. key =
 * `agent:copilot:acp:<uuid>` AND `entry.acp` is present), the agent's
 * configured model is irrelevant: the actual model is selected inside the ACP
 * child process. We overlay a sentinel `{ provider: "acpx",
 * model: "<agentId>-acp" }` so the listing clearly signals "ACP runtime" and
 * does not mislead operators into thinking the configured model ran.
 *
 * Key-shape alone is not sufficient: ACP bridge sessions (translator.ts) also
 * use ACP-shaped keys but never persist `SessionAcpMeta` — they run the
 * normal configured model and must not receive the sentinel. The `acpRuntime`
 * flag is set at row-construction time from `entry.acp != null`.
 *
 * The resolver (`resolveSessionDisplayModelRef`) stays pure; this overlay
 * applies only at the emit sites in this file.
 *
 * NOTE: Will be replaced by a shared `applyAcpModelOverlay` helper from
 * `src/agents/acp-runtime-overlay.ts` once PR 2 lands.
 */
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
    const parsed = Number.parseInt(trimmed, 10);
    return parsed > 0 ? parsed : null;
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

const formatTokensCell = (
  total: number | undefined,
  contextTokens: number | null,
  rich: boolean,
) => {
  if (total === undefined) {
    const ctxLabel = contextTokens ? formatKTokens(contextTokens) : "?";
    const label = `unknown/${ctxLabel} (?%)`;
    return rich ? theme.muted(label.padEnd(TOKENS_PAD)) : label.padEnd(TOKENS_PAD);
  }
  const totalLabel = formatKTokens(total);
  const ctxLabel = contextTokens ? formatKTokens(contextTokens) : "?";
  const pct = contextTokens ? Math.min(999, Math.round((total / contextTokens) * 100)) : null;
  const label = `${totalLabel}/${ctxLabel} (${pct ?? "?"}%)`;
  const padded = label.padEnd(TOKENS_PAD);
  return colorByPct(padded, pct, rich);
};

async function lookupContextTokensForDisplay(model: string): Promise<number | undefined> {
  const { lookupContextTokens } = await contextLookupRuntimeLoader.load();
  return lookupContextTokens(model, { allowAsyncLoad: false });
}

const formatKindCell = (kind: SessionRow["kind"], rich: boolean) => {
  const label = kind.padEnd(KIND_PAD);
  if (!rich) {
    return label;
  }
  if (kind === "group") {
    return theme.accentBright(label);
  }
  if (kind === "global") {
    return theme.warn(label);
  }
  if (kind === "direct") {
    return theme.accent(label);
  }
  return theme.muted(label);
};

function resolveSessionRuntimeLabel(params: {
  cfg: OpenClawConfig;
  entry: SessionEntry;
  agentRuntime: ReturnType<typeof resolveModelAgentRuntimeMetadata>;
  modelProvider: string;
  model: string;
  agentId: string;
  sessionKey: string;
}): string {
  const id = normalizeOptionalLowercaseString(params.agentRuntime.id);
  const resolvedHarness = id && id !== "pi" && id !== "auto" ? id : undefined;
  return resolveAgentRuntimeLabel({
    config: params.cfg,
    sessionEntry: params.entry,
    resolvedHarness,
    fallbackProvider: params.modelProvider,
  });
}

function formatRuntimeCell(runtimeLabel: string, rich: boolean): string {
  const label = runtimeLabel.padEnd(RUNTIME_PAD);
  return rich ? theme.info(label) : label;
}

function toJsonSessionRow(row: SessionRow): Omit<SessionRow, "runtimeLabel"> {
  const { runtimeLabel, ...jsonRow } = row;
  void runtimeLabel;
  return jsonRow;
}

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
  const configuredContextTokens = cfg.agents?.defaults?.contextTokens;
  const configContextTokens =
    configuredContextTokens ??
    (await lookupContextTokensForDisplay(displayDefaults.model)) ??
    DEFAULT_CONTEXT_TOKENS;
  const targets = resolveSessionStoreTargetsOrExit({
    cfg,
    opts: {
      store: opts.store,
      agent: opts.agent,
      allAgents: opts.allAgents,
    },
    runtime,
  });
  if (!targets) {
    return;
  }

  let activeMinutes: number | undefined;
  if (opts.active !== undefined) {
    const parsed = Number.parseInt(opts.active, 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
      runtime.error("--active must be a positive number of minutes, for example --active 30.");
      runtime.exit(1);
      return;
    }
    activeMinutes = parsed;
  }

  const limit = parseSessionsLimit(opts.limit);
  if (limit === null) {
    runtime.error('--limit must be a positive integer or "all", for example --limit 25.');
    runtime.exit(1);
    return;
  }

  const allRows = targets.flatMap((target) => {
    const store = loadSessionStore(target.storePath);
    return Object.entries(store)
      .filter(([, entry]) => {
        if (activeMinutes === undefined) {
          return true;
        }
        const updatedAt = entry?.updatedAt;
        return typeof updatedAt === "number" && Date.now() - updatedAt <= activeMinutes * 60_000;
      })
      .map(([key, entry]) => {
        const row = toSessionDisplayRow(key, entry);
        const agentId = parseAgentSessionKey(row.key)?.agentId ?? target.agentId;
        const acpRuntime = entry?.acp != null;
        const modelRef = applyAcpModelOverlayIfNeeded(
          resolveSessionDisplayModelRef(cfg, row),
          row.key,
          acpRuntime,
        );
        const agentRuntime = resolveModelAgentRuntimeMetadata({
          cfg,
          agentId,
          provider: modelRef.provider,
          model: modelRef.model,
          sessionKey: row.key,
          acpRuntime,
          acpBackend: entry?.acp?.backend,
        });
        return Object.assign({}, row, {
          agentId,
          acpRuntime,
          agentRuntime,
          kind: classifySessionKind(row.key, store[row.key]),
          runtimeLabel: resolveSessionRuntimeLabel({
            cfg,
            entry,
            agentRuntime,
            modelProvider: modelRef.provider,
            model: modelRef.model,
            agentId,
            sessionKey: row.key,
          }),
        });
      });
  });
  const totalCount = allRows.length;
  const rows = selectNewestSessionRows(allRows, limit);
  const hasMore = rows.length < totalCount;

  if (opts.json) {
    const multi = targets.length > 1;
    const aggregate = aggregateAgents || multi;
    writeRuntimeJson(runtime, {
      path: aggregate ? null : (targets[0]?.storePath ?? null),
      stores: aggregate
        ? targets.map((target) => ({
            agentId: target.agentId,
            path: target.storePath,
          }))
        : undefined,
      allAgents: aggregateAgents ? true : undefined,
      count: rows.length,
      totalCount,
      limitApplied: limit ?? null,
      hasMore,
      activeMinutes: activeMinutes ?? null,
      sessions: await Promise.all(
        rows.map(async (row) => {
          const r = toJsonSessionRow(row);
          const modelRef = applyAcpModelOverlayIfNeeded(
            resolveSessionDisplayModelRef(cfg, r),
            r.key,
            row.acpRuntime,
          );
          return {
            ...r,
            totalTokens: resolveSessionTotalTokens(r) ?? null,
            totalTokensFresh:
              typeof r.totalTokens === "number" ? r.totalTokensFresh !== false : false,
            contextTokens:
              r.contextTokens ??
              configuredContextTokens ??
              (await lookupContextTokensForDisplay(modelRef.model)) ??
              configContextTokens ??
              null,
            modelProvider: modelRef.provider,
            model: modelRef.model,
          };
        }),
      ),
    });
    return;
  }

  if (targets.length === 1 && !aggregateAgents) {
    runtime.log(info(`Session store: ${targets[0]?.storePath}`));
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
  const header = [
    ...(showAgentColumn ? ["Agent".padEnd(AGENT_PAD)] : []),
    "Kind".padEnd(KIND_PAD),
    "Key".padEnd(SESSION_KEY_PAD),
    "Age".padEnd(SESSION_AGE_PAD),
    "Model".padEnd(SESSION_MODEL_PAD),
    "Runtime".padEnd(RUNTIME_PAD),
    "Tokens (ctx %)".padEnd(TOKENS_PAD),
    "Flags",
  ].join(" ");

  runtime.log(rich ? theme.heading(header) : header);

  for (const row of rows) {
    const model = applyAcpModelOverlayIfNeeded(
      resolveSessionDisplayModelRef(cfg, row),
      row.key,
      row.acpRuntime,
    ).model;
    const contextTokens =
      row.contextTokens ??
      configuredContextTokens ??
      (await lookupContextTokensForDisplay(model)) ??
      configContextTokens;
    const total = resolveSessionTotalTokens(row);

    const line = [
      ...(showAgentColumn
        ? [rich ? theme.accentBright(row.agentId.padEnd(AGENT_PAD)) : row.agentId.padEnd(AGENT_PAD)]
        : []),
      formatKindCell(row.kind, rich),
      formatSessionKeyCell(row.key, rich),
      formatSessionAgeCell(row.updatedAt, rich),
      formatSessionModelCell(model, rich),
      formatRuntimeCell(row.runtimeLabel, rich),
      formatTokensCell(total, contextTokens ?? null, rich),
      formatSessionFlagsCell(row, rich),
    ].join(" ");

    runtime.log(line.trimEnd());
  }
}

export const __testing = {
  parseSessionsLimit,
} as const;
