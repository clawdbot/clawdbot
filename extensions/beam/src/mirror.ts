import { createHash } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";
import type {
  SessionCatalogHost,
  SessionCatalogTranscriptItem,
} from "openclaw/plugin-sdk/session-catalog";
import {
  listActiveSessionCatalogs,
  type ActiveSessionCatalog,
} from "openclaw/plugin-sdk/session-catalog-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { BEAM_MAX_BODY_BYTES, BEAM_MAX_ITEM_CHARS, BEAM_MAX_ITEMS } from "./types.js";

const MIRROR_CONFIG_PATH = "plugins.entries.beam.config.mirror";
const MIRROR_TOKEN_PATH = `${MIRROR_CONFIG_PATH}.token`;
const DEFAULT_POLL_SECONDS = 30;
const DEFAULT_ACTIVE_WINDOW_MINUTES = 180;
const MIRROR_LIST_LIMIT = 100;
// Strictest transcript-read cap across catalog providers (the Claude Code
// provider rejects limits above 50); asking for more fails the whole read.
const MIRROR_READ_LIMIT = 50;
// Bounds concurrent remote rows and per-tick reads; oldest active sessions
// beyond the cap simply wait until newer ones go idle.
const MIRROR_MAX_SESSIONS = 32;
// Leaves headroom below the receiver's hard body cap for JSON overhead drift.
const MIRROR_BODY_BUDGET_BYTES = BEAM_MAX_BODY_BYTES - 2_048;
// One warning per source per interval keeps a broken endpoint from flooding logs.
const MIRROR_WARN_INTERVAL_MS = 5 * 60_000;

type BeamMirrorConfig = {
  endpoint: string;
  token?: unknown;
  catalogs: string[];
  pollSeconds: number;
  activeWindowMinutes: number;
};

function isLoopbackHostname(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, "");
  return bare === "localhost" || bare === "127.0.0.1" || bare === "::1";
}

const MIRROR_KEYS = new Set([
  "endpoint",
  "token",
  "catalogs",
  "pollSeconds",
  "activeWindowMinutes",
]);

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

/** Returns the mirror config, undefined when mirroring is not configured, or an error string. */
export function parseBeamMirrorConfig(config: unknown): BeamMirrorConfig | undefined | string {
  if (!isRecord(config)) {
    return undefined;
  }
  const plugins = isRecord(config.plugins) ? config.plugins : undefined;
  const entries = isRecord(plugins?.entries) ? plugins.entries : undefined;
  const entry = isRecord(entries?.beam) ? entries.beam : undefined;
  const pluginConfig = isRecord(entry?.config) ? entry.config : undefined;
  const mirror = pluginConfig?.mirror;
  if (mirror === undefined) {
    return undefined;
  }
  if (!isRecord(mirror) || !Object.keys(mirror).every((key) => MIRROR_KEYS.has(key))) {
    return `${MIRROR_CONFIG_PATH} must be a closed object with endpoint/token/catalogs/pollSeconds/activeWindowMinutes`;
  }
  const endpoint = typeof mirror.endpoint === "string" ? mirror.endpoint.trim() : "";
  let parsedEndpoint: URL;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    return `${MIRROR_CONFIG_PATH}.endpoint must be an absolute URL`;
  }
  // Bearer credentials and transcripts must never cross the network in the
  // clear; plaintext HTTP is a loopback-development affordance only.
  if (parsedEndpoint.protocol === "http:") {
    if (!isLoopbackHostname(parsedEndpoint.hostname)) {
      return `${MIRROR_CONFIG_PATH}.endpoint must use https for non-loopback hosts`;
    }
  } else if (parsedEndpoint.protocol !== "https:") {
    return `${MIRROR_CONFIG_PATH}.endpoint must use http(s)`;
  }
  // Explicit per-catalog consent: an omitted or empty list mirrors nothing,
  // so one Beam setting can never silently export third-party catalogs.
  if (
    !Array.isArray(mirror.catalogs) ||
    mirror.catalogs.length === 0 ||
    mirror.catalogs.some((id) => typeof id !== "string" || !id.trim())
  ) {
    return `${MIRROR_CONFIG_PATH}.catalogs must explicitly list the catalog ids to mirror`;
  }
  const catalogs = mirror.catalogs.map((id) => (id as string).trim().toLowerCase());
  return {
    endpoint,
    ...(mirror.token !== undefined ? { token: mirror.token } : {}),
    catalogs,
    pollSeconds: boundedNumber(mirror.pollSeconds, DEFAULT_POLL_SECONDS, 10, 3_600),
    activeWindowMinutes: boundedNumber(
      mirror.activeWindowMinutes,
      DEFAULT_ACTIVE_WINDOW_MINUTES,
      1,
      10_080,
    ),
  };
}

type BeamMirrorItem = { type: "userMessage" | "agentMessage" | "other"; text: string };

export type BeamMirrorUpload = {
  version: 1;
  beamId: string;
  source: string;
  title: string;
  updatedAt: string;
  completed: boolean;
  truncated?: boolean;
  items: BeamMirrorItem[];
};

export function beamMirrorId(catalogId: string, hostId: string, threadId: string): string {
  return createHash("sha256")
    .update(`${catalogId}\0${hostId}\0${threadId}`)
    .digest("hex")
    .slice(0, 32);
}

function clipText(text: string): string {
  return text.length > BEAM_MAX_ITEM_CHARS ? text.slice(0, BEAM_MAX_ITEM_CHARS) : text;
}

function droppedSummary(counts: Map<string, number>): string | undefined {
  if (counts.size === 0) {
    return undefined;
  }
  const parts = [...counts.entries()].map(([kind, count]) => `${count} ${kind}`);
  return `${parts.join(", ")}; raw content dropped`;
}

/**
 * Reduce catalog transcript items to the Beam wire shape. Only user/agent
 * message text crosses the wire; reasoning, tool calls, tool results, and raw
 * payloads collapse into compact counts, matching the beam skill's redaction
 * contract so the mirror never widens what a manual publish would share.
 */
export function buildBeamMirrorItems(items: readonly SessionCatalogTranscriptItem[]): {
  items: BeamMirrorItem[];
  droppedRaw: number;
} {
  const out: BeamMirrorItem[] = [];
  let dropped = new Map<string, number>();
  let droppedRaw = 0;
  const flush = () => {
    const summary = droppedSummary(dropped);
    if (summary) {
      out.push({ type: "other", text: clipText(summary) });
      dropped = new Map();
    }
  };
  const droppedLabel = (type: string): string => {
    switch (type) {
      case "toolCall":
        return "tool calls";
      case "toolResult":
        return "tool results";
      case "reasoning":
        return "reasoning items";
      default:
        return "other entries";
    }
  };
  for (const item of items) {
    const text = item.text?.trim();
    if ((item.type === "userMessage" || item.type === "agentMessage") && text) {
      flush();
      out.push({ type: item.type, text: clipText(text) });
      continue;
    }
    droppedRaw += 1;
    const label = droppedLabel(item.type);
    dropped.set(label, (dropped.get(label) ?? 0) + 1);
  }
  flush();
  return { items: out, droppedRaw };
}

/** Drop oldest items until the payload fits the receiver's item and byte caps. */
export function fitBeamMirrorUpload(upload: BeamMirrorUpload): BeamMirrorUpload {
  let items = upload.items.slice(-BEAM_MAX_ITEMS);
  const truncatedByCount = upload.truncated === true || items.length < upload.items.length;
  let fitted: BeamMirrorUpload = {
    ...upload,
    items,
    ...(truncatedByCount ? { truncated: true } : {}),
  };
  while (
    items.length > 1 &&
    Buffer.byteLength(JSON.stringify(fitted), "utf8") > MIRROR_BODY_BUDGET_BYTES
  ) {
    items = items.slice(1);
    fitted = { ...upload, items, truncated: true };
  }
  return fitted;
}

type BeamMirrorCandidate = {
  catalogId: string;
  hostId: string;
  threadId: string;
  title: string;
  recencyAt: number;
};

function hostCandidates(
  catalogId: string,
  hosts: readonly SessionCatalogHost[],
  activeSinceMs: number,
): BeamMirrorCandidate[] {
  const out: BeamMirrorCandidate[] = [];
  for (const host of hosts) {
    // Node-attached hosts belong to other machines; the mirror shares only
    // sessions that run on this gateway's machine.
    if (host.kind !== "gateway") {
      continue;
    }
    for (const session of host.sessions) {
      const recencyAt = session.recencyAt ?? session.updatedAt ?? 0;
      if (recencyAt < activeSinceMs) {
        continue;
      }
      out.push({
        catalogId,
        hostId: host.hostId,
        threadId: session.threadId,
        title: session.name?.trim() || `${catalogId} session`,
        recencyAt,
      });
    }
  }
  return out;
}

type TrackedMirrorSession = {
  candidate: BeamMirrorCandidate;
  fingerprint: string;
};

type BeamMirrorRunner = {
  tick: () => Promise<void>;
};

export function createBeamMirrorRunner(params: {
  runtime: PluginRuntime;
  logger: { warn: (message: string) => void; info: (message: string) => void };
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  now?: () => number;
  listCatalogs?: () => ActiveSessionCatalog[];
}): BeamMirrorRunner {
  const env = params.env ?? process.env;
  const fetchFn = params.fetchFn ?? fetch;
  const now = params.now ?? Date.now;
  const listCatalogs = params.listCatalogs ?? listActiveSessionCatalogs;
  const tracked = new Map<string, TrackedMirrorSession>();
  let lastWarnAt = 0;
  let running = false;

  const warnThrottled = (message: string) => {
    if (now() - lastWarnAt >= MIRROR_WARN_INTERVAL_MS) {
      lastWarnAt = now();
      params.logger.warn(message);
    }
  };

  const upload = async (
    endpoint: string,
    token: string | undefined,
    payload: BeamMirrorUpload,
  ): Promise<boolean> => {
    const response = await fetchFn(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      warnThrottled(`beam mirror upload failed (${response.status}) for ${payload.source}`);
      return false;
    }
    return true;
  };

  const buildUpload = async (
    catalog: ActiveSessionCatalog,
    candidate: BeamMirrorCandidate,
    completed: boolean,
  ): Promise<BeamMirrorUpload> => {
    const transcript = await catalog.read({
      hostId: candidate.hostId,
      threadId: candidate.threadId,
      limit: MIRROR_READ_LIMIT,
    });
    const reduced = buildBeamMirrorItems(transcript.items);
    const items = reduced.items.length
      ? reduced.items
      : [{ type: "other" as const, text: "no shareable messages yet" }];
    return fitBeamMirrorUpload({
      version: 1,
      beamId: beamMirrorId(candidate.catalogId, candidate.hostId, candidate.threadId),
      source: candidate.catalogId,
      title: candidate.title.slice(0, 160),
      updatedAt: new Date(candidate.recencyAt || now()).toISOString(),
      completed,
      items,
    });
  };

  const mirrorFingerprint = (payload: BeamMirrorUpload): string =>
    createHash("sha256")
      .update(
        JSON.stringify({
          title: payload.title,
          completed: payload.completed,
          items: payload.items,
        }),
      )
      .digest("hex");

  const tick = async (): Promise<void> => {
    if (running) {
      return;
    }
    running = true;
    try {
      const config = params.runtime.config.current();
      const mirror = parseBeamMirrorConfig(config);
      if (mirror === undefined) {
        return;
      }
      if (typeof mirror === "string") {
        warnThrottled(`beam mirror disabled: ${mirror}`);
        return;
      }
      let token: string | undefined;
      if (mirror.token !== undefined) {
        const resolved = await resolveConfiguredSecretInputString({
          // The resolver only reads; the plugin runtime exposes a DeepReadonly view.
          config: config as OpenClawConfig,
          env,
          value: mirror.token,
          path: MIRROR_TOKEN_PATH,
        });
        if (!resolved.value) {
          warnThrottled(
            `beam mirror token unresolved${resolved.unresolvedRefReason ? `: ${resolved.unresolvedRefReason}` : ""}`,
          );
          return;
        }
        token = resolved.value;
      }
      const activeSinceMs = now() - mirror.activeWindowMinutes * 60_000;
      const catalogs = listCatalogs().filter(
        (catalog) =>
          // Never mirror the local beam receiver back out: a two-gateway pair
          // would otherwise re-mirror each other's rows forever.
          catalog.id !== "beam" && mirror.catalogs.includes(catalog.id),
      );
      const catalogById = new Map(catalogs.map((catalog) => [catalog.id, catalog]));
      const candidates: BeamMirrorCandidate[] = [];
      for (const catalog of catalogs) {
        try {
          const hosts = await catalog.list({ limitPerHost: MIRROR_LIST_LIMIT });
          candidates.push(...hostCandidates(catalog.id, hosts, activeSinceMs));
        } catch (error) {
          warnThrottled(`beam mirror list failed for ${catalog.id}: ${String(error)}`);
        }
      }
      candidates.sort((left, right) => right.recencyAt - left.recencyAt);
      const selected = candidates.slice(0, MIRROR_MAX_SESSIONS);
      const selectedKeys = new Set<string>();
      for (const candidate of selected) {
        const key = `${candidate.catalogId}\0${candidate.hostId}\0${candidate.threadId}`;
        selectedKeys.add(key);
        const catalog = catalogById.get(candidate.catalogId);
        if (!catalog) {
          continue;
        }
        try {
          const payload = await buildUpload(catalog, candidate, false);
          const fingerprint = mirrorFingerprint(payload);
          if (tracked.get(key)?.fingerprint === fingerprint) {
            continue;
          }
          if (await upload(mirror.endpoint, token, payload)) {
            tracked.set(key, { candidate, fingerprint });
          }
        } catch (error) {
          warnThrottled(`beam mirror upload failed for ${candidate.catalogId}: ${String(error)}`);
        }
      }
      // Sessions that left the active window get one final completed upload so
      // remote rows flip from live to completed instead of lingering until TTL.
      for (const [key, entry] of tracked) {
        if (selectedKeys.has(key)) {
          continue;
        }
        tracked.delete(key);
        const catalog = catalogById.get(entry.candidate.catalogId);
        if (!catalog) {
          continue;
        }
        try {
          const payload = await buildUpload(catalog, entry.candidate, true);
          await upload(mirror.endpoint, token, payload);
        } catch {
          // The session store may already be gone; the receiver TTL cleans up.
        }
      }
    } finally {
      running = false;
    }
  };

  return { tick };
}

export function createBeamMirrorService(params: { runtime: PluginRuntime }): {
  id: string;
  start: (ctx: { logger: { warn: (m: string) => void; info: (m: string) => void } }) => void;
  stop: () => void;
} {
  let interval: ReturnType<typeof setInterval> | undefined;
  return {
    id: "beam-mirror",
    start(ctx) {
      const mirror = parseBeamMirrorConfig(params.runtime.config.current());
      if (mirror === undefined) {
        return;
      }
      if (typeof mirror === "string") {
        ctx.logger.warn(`beam mirror disabled: ${mirror}`);
        return;
      }
      const runner = createBeamMirrorRunner({ runtime: params.runtime, logger: ctx.logger });
      // The catalog poll is this service's lifecycle-owned freshness exception:
      // local coding sessions change outside gateway events, so a bounded
      // unref'd interval is the only way to observe them.
      interval = setInterval(() => {
        void runner.tick();
      }, mirror.pollSeconds * 1_000);
      interval.unref?.();
      ctx.logger.info(`beam mirror active: ${mirror.catalogs.join(", ")} -> ${mirror.endpoint}`);
      void runner.tick();
    },
    stop() {
      if (interval) {
        clearInterval(interval);
        interval = undefined;
      }
    },
  };
}
