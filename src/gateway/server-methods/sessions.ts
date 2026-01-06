import { randomUUID } from "node:crypto";
import fs from "node:fs";

import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../agents/defaults.js";
import {
  buildAllowedModelSet,
  buildModelAliasIndex,
  modelKey,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "../../agents/model-selection.js";
import {
  abortEmbeddedPiRun,
  isEmbeddedPiRunActive,
  resolveEmbeddedSessionLane,
  waitForEmbeddedPiRunEnd,
} from "../../agents/pi-embedded.js";
import { normalizeGroupActivation } from "../../auto-reply/group-activation.js";
import {
  normalizeThinkLevel,
  normalizeVerboseLevel,
} from "../../auto-reply/thinking.js";
import { loadConfig } from "../../config/config.js";
import {
  loadSessionStore,
  resolveMainSessionKey,
  resolveStorePath,
  type SessionEntry,
  saveSessionStore,
} from "../../config/sessions.js";
import { clearCommandLane } from "../../process/command-queue.js";
import { normalizeSendPolicy } from "../../sessions/send-policy.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateSessionsCompactParams,
  validateSessionsDeleteParams,
  validateSessionsListParams,
  validateSessionsPatchParams,
  validateSessionsResetParams,
} from "../protocol/index.js";
import {
  archiveFileOnDisk,
  listSessionsFromStore,
  loadSessionEntry,
  resolveSessionTranscriptCandidates,
  type SessionsPatchResult,
} from "../session-utils.js";
import type { GatewayRequestHandlers } from "./types.js";

export const sessionsHandlers: GatewayRequestHandlers = {
  "sessions.list": ({ params, respond }) => {
    if (!validateSessionsListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid sessions.list params: ${formatValidationErrors(validateSessionsListParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as import("../protocol/index.js").SessionsListParams;
    const cfg = loadConfig();
    const storePath = resolveStorePath(cfg.session?.store);
    const store = loadSessionStore(storePath);
    const result = listSessionsFromStore({
      cfg,
      storePath,
      store,
      opts: p,
    });
    respond(true, result, undefined);
  },
  "sessions.patch": async ({ params, respond, context }) => {
    if (!validateSessionsPatchParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid sessions.patch params: ${formatValidationErrors(validateSessionsPatchParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as import("../protocol/index.js").SessionsPatchParams;
    const key = String(p.key ?? "").trim();
    if (!key) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "key required"),
      );
      return;
    }

    const cfg = loadConfig();
    const storePath = resolveStorePath(cfg.session?.store);
    const store = loadSessionStore(storePath);
    const now = Date.now();

    const existing = store[key];
    const next: SessionEntry = existing
      ? {
          ...existing,
          updatedAt: Math.max(existing.updatedAt ?? 0, now),
        }
      : { sessionId: randomUUID(), updatedAt: now };

    if ("spawnedBy" in p) {
      const raw = p.spawnedBy;
      if (raw === null) {
        if (existing?.spawnedBy) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              "spawnedBy cannot be cleared once set",
            ),
          );
          return;
        }
      } else if (raw !== undefined) {
        const trimmed = String(raw).trim();
        if (!trimmed) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, "invalid spawnedBy: empty"),
          );
          return;
        }
        if (!key.startsWith("subagent:")) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              "spawnedBy is only supported for subagent:* sessions",
            ),
          );
          return;
        }
        if (existing?.spawnedBy && existing.spawnedBy !== trimmed) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              "spawnedBy cannot be changed once set",
            ),
          );
          return;
        }
        next.spawnedBy = trimmed;
      }
    }

    if ("thinkingLevel" in p) {
      const raw = p.thinkingLevel;
      if (raw === null) {
        delete next.thinkingLevel;
      } else if (raw !== undefined) {
        const normalized = normalizeThinkLevel(String(raw));
        if (!normalized) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              "invalid thinkingLevel (use off|minimal|low|medium|high)",
            ),
          );
          return;
        }
        if (normalized === "off") delete next.thinkingLevel;
        else next.thinkingLevel = normalized;
      }
    }

    if ("verboseLevel" in p) {
      const raw = p.verboseLevel;
      if (raw === null) {
        delete next.verboseLevel;
      } else if (raw !== undefined) {
        const normalized = normalizeVerboseLevel(String(raw));
        if (!normalized) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              'invalid verboseLevel (use "on"|"off")',
            ),
          );
          return;
        }
        if (normalized === "off") delete next.verboseLevel;
        else next.verboseLevel = normalized;
      }
    }

    if ("model" in p) {
      const raw = p.model;
      if (raw === null) {
        delete next.providerOverride;
        delete next.modelOverride;
      } else if (raw !== undefined) {
        const trimmed = String(raw).trim();
        if (!trimmed) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, "invalid model: empty"),
          );
          return;
        }
        const resolvedDefault = resolveConfiguredModelRef({
          cfg,
          defaultProvider: DEFAULT_PROVIDER,
          defaultModel: DEFAULT_MODEL,
        });
        const aliasIndex = buildModelAliasIndex({
          cfg,
          defaultProvider: resolvedDefault.provider,
        });
        const resolved = resolveModelRefFromString({
          raw: trimmed,
          defaultProvider: resolvedDefault.provider,
          aliasIndex,
        });
        if (!resolved) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, `invalid model: ${trimmed}`),
          );
          return;
        }
        const catalog = await context.loadGatewayModelCatalog();
        const allowed = buildAllowedModelSet({
          cfg,
          catalog,
          defaultProvider: resolvedDefault.provider,
        });
        const key = modelKey(resolved.ref.provider, resolved.ref.model);
        if (!allowed.allowAny && !allowed.allowedKeys.has(key)) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, `model not allowed: ${key}`),
          );
          return;
        }
        if (
          resolved.ref.provider === resolvedDefault.provider &&
          resolved.ref.model === resolvedDefault.model
        ) {
          delete next.providerOverride;
          delete next.modelOverride;
        } else {
          next.providerOverride = resolved.ref.provider;
          next.modelOverride = resolved.ref.model;
        }
      }
    }

    if ("sendPolicy" in p) {
      const raw = p.sendPolicy;
      if (raw === null) {
        delete next.sendPolicy;
      } else if (raw !== undefined) {
        const normalized = normalizeSendPolicy(String(raw));
        if (!normalized) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              'invalid sendPolicy (use "allow"|"deny")',
            ),
          );
          return;
        }
        next.sendPolicy = normalized;
      }
    }

    if ("groupActivation" in p) {
      const raw = p.groupActivation;
      if (raw === null) {
        delete next.groupActivation;
      } else if (raw !== undefined) {
        const normalized = normalizeGroupActivation(String(raw));
        if (!normalized) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              'invalid groupActivation (use "mention"|"always")',
            ),
          );
          return;
        }
        next.groupActivation = normalized;
      }
    }

    store[key] = next;
    await saveSessionStore(storePath, store);
    const result: SessionsPatchResult = {
      ok: true,
      path: storePath,
      key,
      entry: next,
    };
    respond(true, result, undefined);
  },
  "sessions.reset": async ({ params, respond }) => {
    if (!validateSessionsResetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid sessions.reset params: ${formatValidationErrors(validateSessionsResetParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as import("../protocol/index.js").SessionsResetParams;
    const key = String(p.key ?? "").trim();
    if (!key) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "key required"),
      );
      return;
    }

    const { storePath, store, entry } = loadSessionEntry(key);
    const now = Date.now();
    const next: SessionEntry = {
      sessionId: randomUUID(),
      updatedAt: now,
      systemSent: false,
      abortedLastRun: false,
      thinkingLevel: entry?.thinkingLevel,
      verboseLevel: entry?.verboseLevel,
      model: entry?.model,
      contextTokens: entry?.contextTokens,
      sendPolicy: entry?.sendPolicy,
      lastChannel: entry?.lastChannel,
      lastTo: entry?.lastTo,
      skillsSnapshot: entry?.skillsSnapshot,
    };
    store[key] = next;
    await saveSessionStore(storePath, store);
    respond(true, { ok: true, key, entry: next }, undefined);
  },
  "sessions.delete": async ({ params, respond }) => {
    if (!validateSessionsDeleteParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid sessions.delete params: ${formatValidationErrors(validateSessionsDeleteParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as import("../protocol/index.js").SessionsDeleteParams;
    const key = String(p.key ?? "").trim();
    if (!key) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "key required"),
      );
      return;
    }

    const mainKey = resolveMainSessionKey(loadConfig());
    if (key === mainKey) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `Cannot delete the main session (${mainKey}).`,
        ),
      );
      return;
    }

    const deleteTranscript =
      typeof p.deleteTranscript === "boolean" ? p.deleteTranscript : true;

    const { storePath, store, entry } = loadSessionEntry(key);
    const sessionId = entry?.sessionId;
    const existed = Boolean(store[key]);
    clearCommandLane(resolveEmbeddedSessionLane(key));
    if (sessionId && isEmbeddedPiRunActive(sessionId)) {
      abortEmbeddedPiRun(sessionId);
      const ended = await waitForEmbeddedPiRunEnd(sessionId, 15_000);
      if (!ended) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            `Session ${key} is still active; try again in a moment.`,
          ),
        );
        return;
      }
    }
    if (existed) delete store[key];
    await saveSessionStore(storePath, store);

    const archived: string[] = [];
    if (deleteTranscript && sessionId) {
      for (const candidate of resolveSessionTranscriptCandidates(
        sessionId,
        storePath,
      )) {
        if (!fs.existsSync(candidate)) continue;
        try {
          archived.push(archiveFileOnDisk(candidate, "deleted"));
        } catch {
          // Best-effort.
        }
      }
    }

    respond(true, { ok: true, key, deleted: existed, archived }, undefined);
  },
  "sessions.compact": async ({ params, respond }) => {
    if (!validateSessionsCompactParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid sessions.compact params: ${formatValidationErrors(validateSessionsCompactParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as import("../protocol/index.js").SessionsCompactParams;
    const key = String(p.key ?? "").trim();
    if (!key) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "key required"),
      );
      return;
    }

    const maxLines =
      typeof p.maxLines === "number" && Number.isFinite(p.maxLines)
        ? Math.max(1, Math.floor(p.maxLines))
        : 400;

    const { storePath, store, entry } = loadSessionEntry(key);
    const sessionId = entry?.sessionId;
    if (!sessionId) {
      respond(
        true,
        { ok: true, key, compacted: false, reason: "no sessionId" },
        undefined,
      );
      return;
    }

    const filePath = resolveSessionTranscriptCandidates(
      sessionId,
      storePath,
    ).find((candidate) => fs.existsSync(candidate));
    if (!filePath) {
      respond(
        true,
        { ok: true, key, compacted: false, reason: "no transcript" },
        undefined,
      );
      return;
    }

    const raw = fs.readFileSync(filePath, "utf-8");
    const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length <= maxLines) {
      respond(
        true,
        { ok: true, key, compacted: false, kept: lines.length },
        undefined,
      );
      return;
    }

    const archived = archiveFileOnDisk(filePath, "bak");
    const keptLines = lines.slice(-maxLines);
    fs.writeFileSync(filePath, `${keptLines.join("\n")}\n`, "utf-8");

    if (store[key]) {
      delete store[key].inputTokens;
      delete store[key].outputTokens;
      delete store[key].totalTokens;
      store[key].updatedAt = Date.now();
      await saveSessionStore(storePath, store);
    }

    respond(
      true,
      {
        ok: true,
        key,
        compacted: true,
        archived,
        kept: keptLines.length,
      },
      undefined,
    );
  },
};
