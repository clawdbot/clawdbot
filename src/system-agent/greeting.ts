// Cached, model-phrased caretaker greetings over deterministic gateway facts.
import { createHash } from "node:crypto";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { SystemAgentChatQuestion } from "../../packages/gateway-protocol/src/index.js";
import type { HealthSummary } from "../commands/health.types.js";
import {
  CONFIG_AUDIT_MAX_ENTRIES,
  CONFIG_AUDIT_SCOPE,
  type ConfigAuditRecord,
} from "../config/io.audit.js";
import { getHealthCache } from "../gateway/server/health-state.js";
import { createSqliteAuditRecordStore } from "../infra/sqlite-audit-record-store.js";
import { getUpdateAvailable, type UpdateAvailable } from "../infra/update-startup.js";
import { formatSystemAgentStartupMessage, type SystemAgentOverview } from "./overview.js";

const SYSTEM_AGENT_GREETING_SCOPE = "system-agent-greeting";
const SYSTEM_AGENT_GREETING_KEY = "latest";
const SYSTEM_AGENT_GREETING_TIMEOUT_MS = 20_000;
const SYSTEM_AGENT_GREETING_FAILURE_RETRY_MS = 60_000;
const SYSTEM_AGENT_GREETING_MAX_CHARS = 700;
const SYSTEM_AGENT_GREETING_MAX_LINES = 5;
const CONFIG_AUDIT_PAGE_SIZE = 5;
const GREETING_STATE_CAS_ATTEMPTS = 4;

export type SystemAgentGreetingFacts = {
  updateAvailable: string | null;
  channelHealth: { available: boolean; degraded: string[] };
  recentExternalEdit: boolean;
  /** Newest config-audit sequence observed while these facts were built. */
  auditSequence: number;
};

export type SystemAgentGreetingCacheRecord = {
  lastSeenAuditSequence: number;
  factsHash?: string;
  text?: string;
  modelRef?: string;
  at?: number;
};

export type SystemAgentGreetingPlan = {
  text: string;
  modelRef: string;
};

export type SystemAgentGreetingPlanner = (params: {
  overview: SystemAgentOverview;
  facts: SystemAgentGreetingFacts;
  timeoutMs: number;
}) => Promise<SystemAgentGreetingPlan | null>;

export type SystemAgentGreetingCacheStore = Pick<
  ReturnType<typeof createSqliteAuditRecordStore<SystemAgentGreetingCacheRecord>>,
  "compareAndSet" | "latest"
>;

type SystemAgentGreetingConfigAuditStore = Pick<
  ReturnType<typeof createSqliteAuditRecordStore<ConfigAuditRecord>>,
  "latest"
>;

type SystemAgentGreetingResolution = {
  text: string;
  source: "cache" | "model" | "template";
};

const greetingFlights = new WeakMap<
  SystemAgentGreetingCacheStore,
  Map<string, Promise<SystemAgentGreetingResolution>>
>();
const greetingFailures = new WeakMap<
  SystemAgentGreetingCacheStore,
  { factsHash: string; retryAfter: number }
>();
let defaultGreetingCache: SystemAgentGreetingCacheStore | undefined;

function openGreetingCache(env?: NodeJS.ProcessEnv): SystemAgentGreetingCacheStore {
  return createSqliteAuditRecordStore<SystemAgentGreetingCacheRecord>({
    scope: SYSTEM_AGENT_GREETING_SCOPE,
    maxEntries: 1,
    ...(env ? { env } : {}),
  });
}

function getDefaultGreetingCache(): SystemAgentGreetingCacheStore {
  defaultGreetingCache ??= openGreetingCache();
  return defaultGreetingCache;
}

function openConfigAuditStore(env?: NodeJS.ProcessEnv): SystemAgentGreetingConfigAuditStore {
  return createSqliteAuditRecordStore<ConfigAuditRecord>({
    scope: CONFIG_AUDIT_SCOPE,
    maxEntries: CONFIG_AUDIT_MAX_ENTRIES,
    ...(env ? { env } : {}),
  });
}

function tryOr<T>(fallback: T, read: () => T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

function readGreetingCache(
  store: SystemAgentGreetingCacheStore,
): SystemAgentGreetingCacheRecord | null {
  return store.latest({ limit: 1 })[0]?.value ?? null;
}

function mutateGreetingState(
  store: SystemAgentGreetingCacheStore,
  mutate: (current: SystemAgentGreetingCacheRecord | null) => SystemAgentGreetingCacheRecord | null,
  createdAt = Date.now(),
): void {
  for (let attempt = 0; attempt < GREETING_STATE_CAS_ATTEMPTS; attempt += 1) {
    const current = readGreetingCache(store);
    const next = mutate(current);
    if (
      next === current ||
      store.compareAndSet(SYSTEM_AGENT_GREETING_KEY, current, next, createdAt)
    ) {
      return;
    }
  }
  throw new Error("system-agent greeting state changed too often");
}

function accountLooksDegraded(account: Record<string, unknown>): boolean {
  if (account.configured === false || account.enabled === false) {
    return false;
  }
  const healthState =
    typeof account.healthState === "string" ? account.healthState.trim().toLowerCase() : "";
  const probe =
    account.probe && typeof account.probe === "object"
      ? (account.probe as Record<string, unknown>)
      : null;
  return (
    (healthState !== "" && healthState !== "healthy") ||
    probe?.ok === false ||
    account.linked === false ||
    account.running === false ||
    (account.running === true && account.connected === false) ||
    (account.connected !== true &&
      typeof account.lastError === "string" &&
      account.lastError.trim().length > 0)
  );
}

/** Extract only degraded channel labels from the gateway's existing cached health aggregate. */
export function systemAgentGreetingChannelHealth(
  health: HealthSummary | null,
): SystemAgentGreetingFacts["channelHealth"] {
  if (!health) {
    return { available: false, degraded: [] };
  }
  const degraded = new Set<string>();
  for (const [channelId, channel] of Object.entries(health.channels)) {
    const accounts = channel.accounts ? Object.values(channel.accounts) : [channel];
    if (accounts.some((account) => accountLooksDegraded(account))) {
      degraded.add(health.channelLabels[channelId] ?? channelId);
    }
  }
  return { available: true, degraded: [...degraded].toSorted((a, b) => a.localeCompare(b)) };
}

function readConfigAuditFacts(
  store: SystemAgentGreetingConfigAuditStore,
  lastSeenAuditSequence: number,
): Pick<SystemAgentGreetingFacts, "auditSequence" | "recentExternalEdit"> {
  let auditSequence = 0;
  let beforeSequence: number | undefined;
  let recentExternalEdit = false;
  while (true) {
    const page = store.latest({
      limit: CONFIG_AUDIT_PAGE_SIZE,
      ...(beforeSequence === undefined ? {} : { beforeSequence }),
    });
    if (beforeSequence === undefined) {
      auditSequence = page[0]?.sequence ?? 0;
    }
    if (page.length === 0) {
      break;
    }
    let reachedWatermark = false;
    for (const entry of page) {
      if (entry.sequence <= lastSeenAuditSequence) {
        reachedWatermark = true;
        break;
      }
      if (entry.value.event === "config.external") {
        recentExternalEdit = true;
      }
    }
    if (reachedWatermark || page.length < CONFIG_AUDIT_PAGE_SIZE) {
      break;
    }
    const nextBeforeSequence = page.at(-1)?.sequence;
    if (nextBeforeSequence === undefined || nextBeforeSequence === beforeSequence) {
      break;
    }
    beforeSequence = nextBeforeSequence;
  }
  return { auditSequence, recentExternalEdit };
}

/** Read free facts from process/SQLite snapshots; this function never starts a probe. */
export function loadSystemAgentGreetingFacts(
  opts: {
    env?: NodeJS.ProcessEnv;
    cacheStore?: SystemAgentGreetingCacheStore;
    openCache?: () => SystemAgentGreetingCacheStore;
    configAuditStore?: SystemAgentGreetingConfigAuditStore;
    getUpdateAvailable?: () => UpdateAvailable | null;
    getHealthCache?: () => HealthSummary | null;
  } = {},
): SystemAgentGreetingFacts {
  // Facts stay best-effort: a broken snapshot source degrades that fact
  // instead of blocking the welcome.
  const cache = tryOr<SystemAgentGreetingCacheRecord | null>(null, () =>
    readGreetingCache(opts.cacheStore ?? opts.openCache?.() ?? openGreetingCache(opts.env)),
  );
  const auditFacts = tryOr({ auditSequence: 0, recentExternalEdit: false }, () =>
    readConfigAuditFacts(
      opts.configAuditStore ?? openConfigAuditStore(opts.env),
      cache?.lastSeenAuditSequence ?? 0,
    ),
  );
  const update = tryOr<UpdateAvailable | null>(null, () =>
    (opts.getUpdateAvailable ?? getUpdateAvailable)(),
  );
  const health = tryOr<HealthSummary | null>(null, () => (opts.getHealthCache ?? getHealthCache)());
  return {
    updateAvailable: update?.latestVersion ?? null,
    channelHealth: systemAgentGreetingChannelHealth(health),
    ...auditFacts,
  };
}

/** SHA-256 over greeting decisions only; paths, errors, timestamps, and tool probes stay out. */
export function systemAgentGreetingFactsHash(
  overview: SystemAgentOverview,
  facts: SystemAgentGreetingFacts,
): string {
  const decisionFacts = {
    config: {
      exists: overview.config.exists,
      valid: overview.config.valid,
    },
    defaultAgentId: overview.defaultAgentId,
    defaultModel: overview.defaultModel ?? null,
    gateway: {
      reachable: overview.gateway.reachable,
      url: overview.gateway.url,
    },
    agents: overview.agents
      .map((agent) => ({
        id: agent.id,
        name: agent.name ?? null,
        isDefault: agent.isDefault,
        model: agent.model ?? null,
      }))
      .toSorted((a, b) => a.id.localeCompare(b.id)),
    updateAvailable: facts.updateAvailable,
    channelHealthAvailable: facts.channelHealth.available,
    degradedChannels: [...facts.channelHealth.degraded].toSorted((a, b) => a.localeCompare(b)),
    // recentExternalEdit is deliberately absent: its alert is host-appended at
    // delivery, so the cached model text stays valid across edit-flag flips.
  };
  return createHash("sha256").update(JSON.stringify(decisionFacts)).digest("hex");
}

function normalizeGreetingText(text: string): string | null {
  const lines = text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, SYSTEM_AGENT_GREETING_MAX_LINES);
  if (lines.length === 0 || lines.some((line) => /^#{1,6}\s/.test(line))) {
    return null;
  }
  // The prompt demands plain markdown lines; structured output must never be
  // cached (a single bad slot would replay on every welcome until facts change).
  // Every retained line is checked so a "Sure:" preamble cannot smuggle JSON.
  if (lines.some((line) => /^[[{]/.test(line) || line.startsWith("```"))) {
    return null;
  }
  return truncateUtf16Safe(lines.join("\n"), SYSTEM_AGENT_GREETING_MAX_CHARS).trim() || null;
}

/**
 * The external-edit alert is host-owned: delivery acknowledges the audit
 * cursor, so a model phrasing miss would silently lose the notification.
 * Appending deterministically removes that class instead of validating it.
 */
export const SYSTEM_AGENT_EXTERNAL_EDIT_ALERT =
  "Heads up: the config was edited outside OpenClaw while I was away — open History to review it.";

function withHostOwnedAlerts(text: string, facts: SystemAgentGreetingFacts): string {
  if (!facts.recentExternalEdit) {
    return text;
  }
  return `${text}\n${SYSTEM_AGENT_EXTERNAL_EDIT_ALERT}`;
}

/**
 * Positive-presence grounding only: exceptional facts the model was given must
 * appear in its text. Deliberately no negative-claim screening — keyword
 * blacklists false-reject phrasing like "no channels are degraded", and the
 * greeting is advisory chat text; chips, History, and health stay host-owned.
 * A hallucinated outage is bounded by the prompt, the 5-line cap, and template
 * fallback on the next facts change. Accepted tradeoff, not an oversight.
 */
function modelGreetingCoversFacts(text: string, facts: SystemAgentGreetingFacts): boolean {
  const normalized = text.toLocaleLowerCase();
  if (facts.updateAvailable && !normalized.includes(facts.updateAvailable.toLocaleLowerCase())) {
    return false;
  }
  if (
    facts.channelHealth.degraded.some((label) => !normalized.includes(label.toLocaleLowerCase()))
  ) {
    return false;
  }
  if (
    !facts.channelHealth.available &&
    !(normalized.includes("channel health") && normalized.includes("unavailable"))
  ) {
    return false;
  }
  return true;
}

function requiresDeterministicGreeting(overview: SystemAgentOverview): boolean {
  return (
    !overview.config.exists ||
    !overview.config.valid ||
    !overview.defaultModel ||
    !overview.gateway.reachable
  );
}

function formatSystemAgentGreetingFallback(
  overview: SystemAgentOverview,
  facts: SystemAgentGreetingFacts,
): string {
  const alerts: string[] = [];
  if (facts.updateAvailable) {
    alerts.push(`Update ${facts.updateAvailable} is available.`);
  }
  if (facts.channelHealth.degraded.length > 0) {
    alerts.push(`Channels needing attention: ${facts.channelHealth.degraded.join(", ")}.`);
  } else if (!facts.channelHealth.available) {
    alerts.push("Channel health is not available yet.");
  }
  // recentExternalEdit is deliberately absent: withHostOwnedAlerts appends the
  // single canonical edit alert to every delivered greeting, template included.
  return [formatSystemAgentStartupMessage(overview), alerts.join(" ") || undefined]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

async function withGreetingTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("system-agent greeting timed out")), timeoutMs);
        if (typeof timer === "object" && "unref" in timer) {
          timer.unref();
        }
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function resolveUncachedSystemAgentGreeting(params: {
  overview: SystemAgentOverview;
  facts: SystemAgentGreetingFacts;
  planner: SystemAgentGreetingPlanner;
  cacheStore: SystemAgentGreetingCacheStore;
  factsHash: string;
  at: number;
  timeoutMs?: number;
}): Promise<SystemAgentGreetingResolution> {
  const timeoutMs = params.timeoutMs ?? SYSTEM_AGENT_GREETING_TIMEOUT_MS;
  let plan: SystemAgentGreetingPlan | null = null;
  try {
    // This is the only metered greeting turn. The single-slot hash keeps unchanged
    // caretaker opens at zero tokens while preserving a model-free rescue path.
    plan = await withGreetingTimeout(
      params.planner({ overview: params.overview, facts: params.facts, timeoutMs }),
      timeoutMs,
    );
  } catch {
    plan = null;
  }
  const text = plan ? normalizeGreetingText(plan.text) : null;
  const groundedText = text && modelGreetingCoversFacts(text, params.facts) ? text : null;
  if (!groundedText || !plan?.modelRef.trim()) {
    // Keep provider outages cheap without writing a template into the model-greeting cache.
    greetingFailures.set(params.cacheStore, {
      factsHash: params.factsHash,
      retryAfter: params.at + SYSTEM_AGENT_GREETING_FAILURE_RETRY_MS,
    });
    return {
      text: formatSystemAgentGreetingFallback(params.overview, params.facts),
      source: "template",
    };
  }
  greetingFailures.delete(params.cacheStore);
  try {
    mutateGreetingState(
      params.cacheStore,
      (current) => {
        // A slower turn for old facts must not replace a newer system-state greeting.
        if (
          current?.factsHash &&
          current.factsHash !== params.factsHash &&
          (current.at ?? Number.NEGATIVE_INFINITY) >= params.at
        ) {
          return current;
        }
        return {
          ...current,
          lastSeenAuditSequence: current?.lastSeenAuditSequence ?? 0,
          factsHash: params.factsHash,
          text: groundedText,
          modelRef: plan.modelRef.trim(),
          at: params.at,
        };
      },
      params.at,
    );
  } catch {
    // Cache persistence is diagnostic-only; a successful greeting still wins.
  }
  return { text: groundedText, source: "model" };
}

type ResolveSystemAgentGreetingParams = {
  overview: SystemAgentOverview;
  facts: SystemAgentGreetingFacts;
  planner: SystemAgentGreetingPlanner;
  /** False for internal session seeding: cache reads stay free and a miss uses the template. */
  allowInference?: boolean;
  cacheStore?: SystemAgentGreetingCacheStore;
  openCache?: () => SystemAgentGreetingCacheStore;
  now?: () => number;
  timeoutMs?: number;
};

export async function resolveSystemAgentGreeting(
  params: ResolveSystemAgentGreetingParams,
): Promise<SystemAgentGreetingResolution> {
  const resolution = await resolveSystemAgentGreetingText(params);
  // Host-owned alerts append at delivery, never into the cache: the cached
  // model text must stay valid for deliveries where the fact is absent.
  return { ...resolution, text: withHostOwnedAlerts(resolution.text, params.facts) };
}

async function resolveSystemAgentGreetingText(
  params: ResolveSystemAgentGreetingParams,
): Promise<SystemAgentGreetingResolution> {
  if (requiresDeterministicGreeting(params.overview)) {
    // When the system is broken, precision beats personality: the rescue path
    // must neither depend on nor spend inference, and model text is never cached.
    return {
      text: formatSystemAgentGreetingFallback(params.overview, params.facts),
      source: "template",
    };
  }
  let cacheStore: SystemAgentGreetingCacheStore;
  try {
    cacheStore = params.cacheStore ?? params.openCache?.() ?? getDefaultGreetingCache();
  } catch {
    return {
      text: formatSystemAgentGreetingFallback(params.overview, params.facts),
      source: "template",
    };
  }
  const factsHash = systemAgentGreetingFactsHash(params.overview, params.facts);
  let cached: SystemAgentGreetingCacheRecord | null;
  try {
    cached = readGreetingCache(cacheStore);
  } catch {
    return {
      text: formatSystemAgentGreetingFallback(params.overview, params.facts),
      source: "template",
    };
  }
  if (
    typeof cached?.text === "string" &&
    cached.text.trim() &&
    cached.factsHash === factsHash &&
    typeof cached.modelRef === "string" &&
    typeof cached.at === "number"
  ) {
    return { text: cached.text, source: "cache" };
  }
  if (params.allowInference === false) {
    return {
      text: formatSystemAgentGreetingFallback(params.overview, params.facts),
      source: "template",
    };
  }

  const at = (params.now ?? Date.now)();
  // This timestamp orders competing model-cache writes; audit acknowledgement uses
  // the monotonic sequence captured with the facts instead of wall-clock time.
  const failure = greetingFailures.get(cacheStore);
  if (failure?.factsHash === factsHash && failure.retryAfter > at) {
    return {
      text: formatSystemAgentGreetingFallback(params.overview, params.facts),
      source: "template",
    };
  }
  if (failure && failure.retryAfter <= at) {
    greetingFailures.delete(cacheStore);
  }
  let flights = greetingFlights.get(cacheStore);
  if (!flights) {
    flights = new Map();
    greetingFlights.set(cacheStore, flights);
  }
  const existingFlight = flights.get(factsHash);
  if (existingFlight) {
    return existingFlight;
  }
  const flight = resolveUncachedSystemAgentGreeting({
    ...params,
    cacheStore,
    factsHash,
    at,
  });
  flights.set(factsHash, flight);
  try {
    return await flight;
  } finally {
    if (flights.get(factsHash) === flight) {
      flights.delete(factsHash);
    }
  }
}

/** Persist the config-audit cursor only after the host has delivered the greeting. */
export function acknowledgeSystemAgentGreetingDelivery(params: {
  auditSequence: number;
  cacheStore?: SystemAgentGreetingCacheStore;
  openCache?: () => SystemAgentGreetingCacheStore;
  now?: () => number;
}): void {
  if (!Number.isSafeInteger(params.auditSequence) || params.auditSequence < 0) {
    return;
  }
  try {
    const cacheStore = params.cacheStore ?? params.openCache?.() ?? getDefaultGreetingCache();
    mutateGreetingState(
      cacheStore,
      (current) => {
        const lastSeenAuditSequence = Math.max(
          current?.lastSeenAuditSequence ?? 0,
          params.auditSequence,
        );
        if (current?.lastSeenAuditSequence === lastSeenAuditSequence) {
          return current;
        }
        return {
          ...current,
          lastSeenAuditSequence,
        };
      },
      (params.now ?? Date.now)(),
    );
  } catch {
    // Delivery wins even when diagnostic acknowledgement cannot be persisted.
  }
}

function addQuickAction(
  options: SystemAgentChatQuestion["options"],
  option: SystemAgentChatQuestion["options"][number],
): void {
  if (options.length >= 4 || options.some((candidate) => candidate.reply === option.reply)) {
    return;
  }
  options.push(option);
}

/** Quick actions are host-derived so model wording can never invent executable replies. */
export function buildSystemAgentGreetingQuestion(
  overview: SystemAgentOverview,
  facts: SystemAgentGreetingFacts,
): SystemAgentChatQuestion {
  const exceptional: SystemAgentChatQuestion["options"] = [];
  if (!overview.config.exists) {
    addQuickAction(exceptional, { label: "Set up OpenClaw", reply: "setup" });
  } else if (!overview.config.valid) {
    addQuickAction(exceptional, { label: "Inspect config", reply: "doctor" });
  } else if (!overview.defaultModel) {
    // A valid config without verified inference cannot hand off to an agent;
    // setup is the canonical path to establish a model.
    addQuickAction(exceptional, { label: "Set up inference", reply: "setup" });
  }
  if (!overview.gateway.reachable) {
    addQuickAction(exceptional, { label: "Run gateway status", reply: "gateway status" });
    addQuickAction(exceptional, { label: "Restart gateway", reply: "restart gateway" });
  }
  if (!facts.channelHealth.available || facts.channelHealth.degraded.length > 0) {
    addQuickAction(exceptional, { label: "Check channel health", reply: "health" });
  }
  if (facts.updateAvailable) {
    addQuickAction(exceptional, { label: "Show update", reply: "status" });
  }
  // Keep History and agent handoff reachable even when several exceptional facts compete
  // for the schema's four slots. The greeting itself still names every exceptional fact.
  const options = exceptional.slice(0, 2);
  // Without a model the handoff chip would advertise a dead action; the
  // no-model branch above already routes users to setup instead.
  if (overview.defaultModel) {
    addQuickAction(options, {
      label: "Talk to my agent",
      reply: "talk to agent",
      recommended:
        exceptional.length === 0 &&
        !facts.recentExternalEdit &&
        facts.channelHealth.available &&
        overview.config.exists &&
        overview.config.valid &&
        overview.gateway.reachable,
    });
  }
  addQuickAction(options, {
    label: facts.recentExternalEdit ? "Review recent changes" : "Show recent changes",
    reply: "audit",
  });
  return {
    id: "system-agent-quick-actions",
    header: "Quick actions",
    question: "What would you like me to do?",
    options,
  };
}
