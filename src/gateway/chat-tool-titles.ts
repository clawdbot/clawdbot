/**
 * Cheap-model purpose titles for tool calls shown in the Control UI.
 *
 * Model selection delegates to the canonical utility-model resolver and
 * follows the platform-wide utilityModel contract: an explicit utilityModel
 * is an operator decision and may name any provider (exactly like session
 * titles, thread titles, and narration, which already send bounded session
 * content there); the AUTO-derived small-model default stays on the session's
 * own provider so no silent new egress destination appears; and an explicit
 * empty utilityModel disables titles entirely. Titles never fall through to
 * the (potentially expensive) primary model — callers get an empty result and
 * keep deterministic labels.
 *
 * Generated titles cache in the per-agent SQLite database (`cache_entries`,
 * scope below) keyed by a digest of tool name + input, so reopening a session
 * never re-bills the same calls.
 */
import { createHash } from "node:crypto";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { DEFAULT_PROVIDER } from "../agents/defaults.js";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import { parseModelRef } from "../agents/model-selection-normalize.js";
import {
  completeWithPreparedSimpleCompletionModel,
  prepareSimpleCompletionModelForAgent,
} from "../agents/simple-completion-runtime.js";
import { resolveUtilityModelRefForAgent } from "../agents/utility-model.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logVerbose } from "../globals.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { redactToolPayloadText } from "../logging/redact.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";

const TOOL_TITLE_CACHE_SCOPE = "tool-call-titles";
const TOOL_TITLES_MAX_ITEMS = 24;
const TOOL_TITLE_INPUT_MAX_CHARS = 2_000;
const TOOL_TITLE_MAX_CHARS = 72;
// Reasoning models spend output tokens before the visible JSON; a small cap
// can starve a whole batch of titles.
const TOOL_TITLES_MAX_TOKENS = 4_096;
const TOOL_TITLES_TIMEOUT_MS = 20_000;

const TOOL_TITLES_SYSTEM_PROMPT = [
  "You label tool calls in a coding agent's activity feed.",
  "For each item, write a 3-8 word title describing the call's purpose in sentence case.",
  "Start with a past-tense verb such as Checked, Inspected, Installed, Listed.",
  "No trailing period, no quotes, no markdown.",
  'Respond with JSON only: {"titles":{"<id>":"<title>"}} covering every item id.',
].join(" ");

export type ToolTitleRequestItem = { id: string; name: string; input: string };

type AgentCacheDatabase = Pick<OpenClawAgentKyselyDatabase, "cache_entries">;

function cacheKeyFor(item: ToolTitleRequestItem): string {
  return createHash("sha256").update(`${item.name}\0${item.input}`).digest("hex");
}

function normalizeItems(items: readonly ToolTitleRequestItem[]): ToolTitleRequestItem[] {
  const seen = new Set<string>();
  const normalized: ToolTitleRequestItem[] = [];
  for (const item of items) {
    if (normalized.length >= TOOL_TITLES_MAX_ITEMS) {
      break;
    }
    const id = item.id.trim();
    const name = item.name.trim();
    // Redact before anything downstream (cache key + model prompt): transcript
    // args can carry raw tokens/signed URLs, and titles must not become a new
    // secret egress path. Redaction runs on the full schema-bounded input and
    // only then truncates — slicing first could bisect a secret so its
    // fragment no longer matches any redaction pattern.
    const input = truncateUtf16Safe(redactToolPayloadText(item.input), TOOL_TITLE_INPUT_MAX_CHARS);
    if (!id || !name || !input.trim() || seen.has(id)) {
      continue;
    }
    seen.add(id);
    normalized.push({ id, name, input });
  }
  return normalized;
}

function normalizeTitle(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const singleLine = raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'`]+|["'`.]+$/g, "");
  return singleLine ? truncateUtf16Safe(singleLine, TOOL_TITLE_MAX_CHARS) : null;
}

function parseTitlesResponse(text: string): Record<string, unknown> | null {
  const stripped = text
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    const parsed = JSON.parse(stripped.slice(start, end + 1)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const titles = (parsed as { titles?: unknown }).titles;
    if (!titles || typeof titles !== "object" || Array.isArray(titles)) {
      return null;
    }
    return titles as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readCachedTitles(agentId: string, keysByItemId: Map<string, string>): Map<string, string> {
  const cached = new Map<string, string>();
  if (keysByItemId.size === 0) {
    return cached;
  }
  try {
    const database = openOpenClawAgentDatabase({ agentId });
    const kysely = getNodeSqliteKysely<AgentCacheDatabase>(database.db);
    const keys = [...new Set(keysByItemId.values())];
    const rows = executeSqliteQuerySync(
      database.db,
      kysely
        .selectFrom("cache_entries")
        .select(["key", "value_json"])
        .where("scope", "=", TOOL_TITLE_CACHE_SCOPE)
        .where("key", "in", keys),
    ).rows;
    const titlesByKey = new Map<string, string>();
    for (const row of rows) {
      if (!row.value_json) {
        continue;
      }
      try {
        const title = normalizeTitle(JSON.parse(row.value_json));
        if (title) {
          titlesByKey.set(row.key, title);
        }
      } catch {
        // Ignore malformed cache rows; they get rewritten on the next generate.
      }
    }
    for (const [itemId, key] of keysByItemId) {
      const title = titlesByKey.get(key);
      if (title) {
        cached.set(itemId, title);
      }
    }
  } catch (err) {
    logVerbose(`chat-tool-titles: cache read failed: ${String(err)}`);
  }
  return cached;
}

function writeCachedTitles(agentId: string, entries: Map<string, string>): void {
  if (entries.size === 0) {
    return;
  }
  try {
    runOpenClawAgentWriteTransaction(
      (database) => {
        const kysely = getNodeSqliteKysely<AgentCacheDatabase>(database.db);
        const now = Date.now();
        for (const [key, title] of entries) {
          executeSqliteQuerySync(
            database.db,
            kysely
              .insertInto("cache_entries")
              .values({
                scope: TOOL_TITLE_CACHE_SCOPE,
                key,
                value_json: JSON.stringify(title),
                blob: null,
                expires_at: null,
                updated_at: now,
              })
              .onConflict((oc) =>
                oc
                  .columns(["scope", "key"])
                  .doUpdateSet({ value_json: JSON.stringify(title), updated_at: now }),
              ),
          );
        }
      },
      { agentId },
    );
  } catch (err) {
    logVerbose(`chat-tool-titles: cache write failed: ${String(err)}`);
  }
}

async function generateMissingTitles(params: {
  cfg: OpenClawConfig;
  agentId: string;
  modelRef: string;
  sessionAuthProfile?: string;
  items: ToolTitleRequestItem[];
}): Promise<Map<string, string>> {
  const generated = new Map<string, string>();
  if (params.items.length === 0) {
    return generated;
  }
  let prepared: Awaited<ReturnType<typeof prepareSimpleCompletionModelForAgent>>;
  try {
    prepared = await prepareSimpleCompletionModelForAgent({
      cfg: params.cfg,
      agentId: params.agentId,
      modelRef: params.modelRef,
      // Profile-isolated sessions must not leak their tool args through the
      // agent/default credential; the session's auth profile wins.
      preferredProfile: params.sessionAuthProfile,
      useAsyncModelResolution: true,
      allowMissingApiKeyModes: ["aws-sdk"],
    });
  } catch (err) {
    logVerbose(`chat-tool-titles: model preparation failed: ${String(err)}`);
    return generated;
  }
  if ("error" in prepared) {
    logVerbose(`chat-tool-titles: ${prepared.error}`);
    return generated;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOOL_TITLES_TIMEOUT_MS);
  try {
    const result = await completeWithPreparedSimpleCompletionModel({
      model: prepared.model,
      auth: prepared.auth,
      cfg: params.cfg,
      context: {
        systemPrompt: TOOL_TITLES_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: JSON.stringify({
              // Caller ids never reach the model: they are unbounded client
              // input; local batch indexes are remapped on the way out.
              items: params.items.map((item, index) => ({
                id: String(index),
                tool: item.name,
                input: item.input,
              })),
            }),
            timestamp: Date.now(),
          },
        ],
      },
      options: {
        maxTokens: Math.min(TOOL_TITLES_MAX_TOKENS, Math.floor(prepared.model.maxTokens)),
        signal: controller.signal,
      },
    });
    if (result.stopReason === "error") {
      logVerbose(`chat-tool-titles: completion failed: ${result.errorMessage ?? "unknown error"}`);
      return generated;
    }
    const text = result.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
    const titles = text ? parseTitlesResponse(text) : null;
    if (!titles) {
      return generated;
    }
    params.items.forEach((item, index) => {
      const title = normalizeTitle(titles[String(index)]);
      if (title) {
        generated.set(item.id, title);
      }
    });
    return generated;
  } catch (err) {
    logVerbose(`chat-tool-titles: completion failed: ${String(err)}`);
    return generated;
  } finally {
    clearTimeout(timeout);
  }
}

/** Resolve purpose titles for tool calls: cache first, one batched cheap-model call for misses. */
export async function generateToolCallTitles(params: {
  cfg: OpenClawConfig;
  agentId: string;
  /** Provider of the session's effective model (honors per-session overrides). */
  sessionPrimaryProvider?: string;
  /** Session auth-profile override; keeps the utility call on the session's credential. */
  sessionAuthProfile?: string;
  items: readonly ToolTitleRequestItem[];
}): Promise<Record<string, string>> {
  const items = normalizeItems(params.items);
  if (items.length === 0) {
    return {};
  }
  // Canonical utility routing decides eligibility BEFORE cache reads: cached
  // titles must not outlive a later `utilityModel: ""` opt-out while the
  // controlUi toggle stays on. An explicit utilityModel is an operator
  // decision and may be cross-provider (the documented utility-task contract
  // shared with session/thread titles and narration); only the AUTO-derived
  // default is pinned to the SESSION's effective provider (per-session model
  // overrides included). Never the primary model itself.
  const resolvedRef = resolveUtilityModelRefForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
    primaryProvider: params.sessionPrimaryProvider,
  });
  if (!resolvedRef) {
    logVerbose(
      "chat-tool-titles: utility routing is disabled or has no derived small-model default; skipping titles",
    );
    return {};
  }
  // Preparation falls back to the agent primary when a modelRef cannot be
  // parsed; a malformed explicit utilityModel (e.g. "openai/") must fail
  // closed instead of billing the primary with tool arguments.
  const strippedRef = splitTrailingAuthProfile(resolvedRef).model;
  if (!parseModelRef(strippedRef, params.sessionPrimaryProvider?.trim() || DEFAULT_PROVIDER)) {
    logVerbose(
      `chat-tool-titles: utility model ref ${JSON.stringify(resolvedRef)} is malformed; skipping titles`,
    );
    return {};
  }
  // The resolved ref can carry the agent primary's trailing @profile, and an
  // embedded profile outranks preferredProfile during preparation. Rewrite it
  // so a profile-isolated session never bills or leaks through the agent's
  // default credential.
  const modelRef = params.sessionAuthProfile
    ? `${strippedRef}@${params.sessionAuthProfile}`
    : resolvedRef;
  const keysByItemId = new Map(items.map((item) => [item.id, cacheKeyFor(item)] as const));
  const titles = readCachedTitles(params.agentId, keysByItemId);
  const missing = items.filter((item) => !titles.has(item.id));
  if (missing.length > 0) {
    const generated = await generateMissingTitles({
      cfg: params.cfg,
      agentId: params.agentId,
      modelRef,
      sessionAuthProfile: params.sessionAuthProfile,
      items: missing,
    });
    if (generated.size > 0) {
      const cacheWrites = new Map<string, string>();
      for (const [itemId, title] of generated) {
        titles.set(itemId, title);
        const key = keysByItemId.get(itemId);
        if (key) {
          cacheWrites.set(key, title);
        }
      }
      writeCachedTitles(params.agentId, cacheWrites);
    }
  }
  return Object.fromEntries(titles);
}
