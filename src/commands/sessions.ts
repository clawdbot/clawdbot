import { lookupContextTokens } from "../agents/context.js";
import {
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
} from "../agents/defaults.js";
import { resolveConfiguredModelRef } from "../agents/model-selection.js";
import { loadConfig } from "../config/config.js";
import {
  loadSessionStore,
  resolveStorePath,
  type SessionEntry,
} from "../config/sessions.js";
import { info } from "../globals.js";
import type { RuntimeEnv } from "../runtime.js";
import { isRich, theme } from "../terminal/theme.js";

type SessionRow = {
  key: string;
  kind: "direct" | "group" | "global" | "unknown";
  updatedAt: number | null;
  ageMs: number | null;
  sessionId?: string;
  systemSent?: boolean;
  abortedLastRun?: boolean;
  thinkingLevel?: string;
  verboseLevel?: string;
  reasoningLevel?: string;
  groupActivation?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  model?: string;
  contextTokens?: number;
};

const KIND_PAD = 6;
const KEY_PAD = 26;
const AGE_PAD = 9;
const MODEL_PAD = 14;
const TOKENS_PAD = 20;

const formatKTokens = (value: number) =>
  `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`;

const truncateKey = (key: string) => {
  if (key.length <= KEY_PAD) return key;
  const head = Math.max(4, KEY_PAD - 10);
  return `${key.slice(0, head)}...${key.slice(-6)}`;
};

const colorByPct = (label: string, pct: number | null, rich: boolean) => {
  if (!rich || pct === null) return label;
  if (pct >= 95) return theme.error(label);
  if (pct >= 80) return theme.warn(label);
  if (pct >= 60) return theme.success(label);
  return theme.muted(label);
};

const formatTokensCell = (
  total: number,
  contextTokens: number | null,
  rich: boolean,
) => {
  if (!total) return "-".padEnd(TOKENS_PAD);
  const totalLabel = formatKTokens(total);
  const ctxLabel = contextTokens ? formatKTokens(contextTokens) : "?";
  const pct = contextTokens
    ? Math.min(999, Math.round((total / contextTokens) * 100))
    : null;
  const label = `${totalLabel}/${ctxLabel} (${pct ?? "?"}%)`;
  const padded = label.padEnd(TOKENS_PAD);
  return colorByPct(padded, pct, rich);
};

const formatKindCell = (kind: SessionRow["kind"], rich: boolean) => {
  const label = kind.padEnd(KIND_PAD);
  if (!rich) return label;
  if (kind === "group") return theme.accentBright(label);
  if (kind === "global") return theme.warn(label);
  if (kind === "direct") return theme.accent(label);
  return theme.muted(label);
};

const formatAgeCell = (updatedAt: number | null | undefined, rich: boolean) => {
  const ageLabel = updatedAt ? formatAge(Date.now() - updatedAt) : "unknown";
  const padded = ageLabel.padEnd(AGE_PAD);
  return rich ? theme.muted(padded) : padded;
};

const formatModelCell = (model: string | null | undefined, rich: boolean) => {
  const label = (model ?? "unknown").padEnd(MODEL_PAD);
  return rich ? theme.info(label) : label;
};

const formatFlagsCell = (row: SessionRow, rich: boolean) => {
  const flags = [
    row.thinkingLevel ? `think:${row.thinkingLevel}` : null,
    row.verboseLevel ? `verbose:${row.verboseLevel}` : null,
    row.reasoningLevel ? `reasoning:${row.reasoningLevel}` : null,
    row.groupActivation ? `activation:${row.groupActivation}` : null,
    row.systemSent ? "system" : null,
    row.abortedLastRun ? "aborted" : null,
    row.sessionId ? `id:${row.sessionId}` : null,
  ].filter(Boolean);
  const label = flags.join(" ");
  return label.length === 0 ? "" : rich ? theme.muted(label) : label;
};

const formatAge = (ms: number | null | undefined) => {
  if (!ms || ms < 0) return "unknown";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
};

function classifyKey(key: string, entry?: SessionEntry): SessionRow["kind"] {
  if (key === "global") return "global";
  if (key === "unknown") return "unknown";
  if (entry?.chatType === "group" || entry?.chatType === "room") return "group";
  if (
    key.startsWith("group:") ||
    key.includes(":group:") ||
    key.includes(":channel:")
  ) {
    return "group";
  }
  return "direct";
}

function toRows(store: Record<string, SessionEntry>): SessionRow[] {
  return Object.entries(store)
    .map(([key, entry]) => {
      const updatedAt = entry?.updatedAt ?? null;
      return {
        key,
        kind: classifyKey(key, entry),
        updatedAt,
        ageMs: updatedAt ? Date.now() - updatedAt : null,
        sessionId: entry?.sessionId,
        systemSent: entry?.systemSent,
        abortedLastRun: entry?.abortedLastRun,
        thinkingLevel: entry?.thinkingLevel,
        verboseLevel: entry?.verboseLevel,
        reasoningLevel: entry?.reasoningLevel,
        groupActivation: entry?.groupActivation,
        inputTokens: entry?.inputTokens,
        outputTokens: entry?.outputTokens,
        totalTokens: entry?.totalTokens,
        model: entry?.model,
        contextTokens: entry?.contextTokens,
      } satisfies SessionRow;
    })
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

export async function sessionsCommand(
  opts: { json?: boolean; store?: string; active?: string },
  runtime: RuntimeEnv,
) {
  const cfg = loadConfig();
  const resolved = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const configContextTokens =
    cfg.agent?.contextTokens ??
    lookupContextTokens(resolved.model) ??
    DEFAULT_CONTEXT_TOKENS;
  const configModel = resolved.model ?? DEFAULT_MODEL;
  const storePath = resolveStorePath(opts.store ?? cfg.session?.store);
  const store = loadSessionStore(storePath);

  let activeMinutes: number | undefined;
  if (opts.active !== undefined) {
    const parsed = Number.parseInt(String(opts.active), 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
      runtime.error("--active must be a positive integer (minutes)");
      runtime.exit(1);
      return;
    }
    activeMinutes = parsed;
  }

  const rows = toRows(store).filter((row) => {
    if (activeMinutes === undefined) return true;
    if (!row.updatedAt) return false;
    return Date.now() - row.updatedAt <= activeMinutes * 60_000;
  });

  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          path: storePath,
          count: rows.length,
          activeMinutes: activeMinutes ?? null,
          sessions: rows.map((r) => ({
            ...r,
            contextTokens:
              r.contextTokens ??
              lookupContextTokens(r.model) ??
              configContextTokens ??
              null,
            model: r.model ?? configModel ?? null,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  runtime.log(info(`Session store: ${storePath}`));
  runtime.log(info(`Sessions listed: ${rows.length}`));
  if (activeMinutes) {
    runtime.log(info(`Filtered to last ${activeMinutes} minute(s)`));
  }
  if (rows.length === 0) {
    runtime.log("No sessions found.");
    return;
  }

  const rich = isRich();
  const header = [
    "Kind".padEnd(KIND_PAD),
    "Key".padEnd(KEY_PAD),
    "Age".padEnd(AGE_PAD),
    "Model".padEnd(MODEL_PAD),
    "Tokens (ctx %)".padEnd(TOKENS_PAD),
    "Flags",
  ].join(" ");

  runtime.log(rich ? theme.heading(header) : header);

  for (const row of rows) {
    const model = row.model ?? configModel;
    const contextTokens =
      row.contextTokens ?? lookupContextTokens(model) ?? configContextTokens;
    const input = row.inputTokens ?? 0;
    const output = row.outputTokens ?? 0;
    const total = row.totalTokens ?? input + output;

    const keyLabel = truncateKey(row.key).padEnd(KEY_PAD);
    const keyCell = rich ? theme.accent(keyLabel) : keyLabel;

    const line = [
      formatKindCell(row.kind, rich),
      keyCell,
      formatAgeCell(row.updatedAt, rich),
      formatModelCell(model, rich),
      formatTokensCell(total, contextTokens ?? null, rich),
      formatFlagsCell(row, rich),
    ].join(" ");

    runtime.log(line.trimEnd());
  }
}
