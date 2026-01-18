import { randomUUID } from "node:crypto";
import fs from "node:fs";
import {
  abortEmbeddedPiRun,
  isEmbeddedPiRunActive,
  resolveEmbeddedSessionLane,
  waitForEmbeddedPiRunEnd,
} from "../agents/pi-embedded.js";
import { loadConfig } from "../config/config.js";
import {
  resolveMainSessionKeyFromConfig,
  snapshotSessionOrigin,
  type SessionEntry,
  updateSessionStore,
} from "../config/sessions.js";
import { clearCommandLane } from "../process/command-queue.js";
import {
  ErrorCodes,
  formatValidationErrors,
  type SessionsCompactParams,
  type SessionsDeleteParams,
  type SessionsListParams,
  type SessionsPatchParams,
  type SessionsResetParams,
  type SessionsResolveParams,
  validateSessionsCompactParams,
  validateSessionsDeleteParams,
  validateSessionsListParams,
  validateSessionsPatchParams,
  validateSessionsResetParams,
  validateSessionsResolveParams,
} from "./protocol/index.js";
import type { BridgeMethodHandler } from "./server-bridge-types.js";
import {
  archiveFileOnDisk,
  listSessionsFromStore,
  loadCombinedSessionStoreForGateway,
  loadSessionEntry,
  resolveGatewaySessionStoreTarget,
  resolveSessionTranscriptCandidates,
  type SessionsPatchResult,
} from "./session-utils.js";
import { applySessionsPatchToStore } from "./sessions-patch.js";
import { resolveSessionKeyFromResolveParams } from "./sessions-resolve.js";

export const handleSessionsBridgeMethods: BridgeMethodHandler = async (
  ctx,
  _nodeId,
  method,
  params,
) => {
  switch (method) {
    case "sessions.list": {
      if (!validateSessionsListParams(params)) {
        return {
          ok: false,
          error: {
            code: ErrorCodes.INVALID_REQUEST,
            message: `invalid sessions.list params: ${formatValidationErrors(validateSessionsListParams.errors)}`,
          },
        };
      }
      const p = params as SessionsListParams;
      const cfg = loadConfig();
      const { storePath, store } = loadCombinedSessionStoreForGateway(cfg);
      const result = listSessionsFromStore({
        cfg,
        storePath,
        store,
        opts: p,
      });
      return { ok: true, payloadJSON: JSON.stringify(result) };
    }
    case "sessions.resolve": {
      if (!validateSessionsResolveParams(params)) {
        return {
          ok: false,
          error: {
            code: ErrorCodes.INVALID_REQUEST,
            message: `invalid sessions.resolve params: ${formatValidationErrors(validateSessionsResolveParams.errors)}`,
          },
        };
      }

      const p = params as SessionsResolveParams;
      const cfg = loadConfig();
      const resolved = resolveSessionKeyFromResolveParams({ cfg, p });
      if (!resolved.ok) {
        return {
          ok: false,
          error: {
            code: resolved.error.code,
            message: resolved.error.message,
            details: resolved.error.details,
          },
        };
      }
      return {
        ok: true,
        payloadJSON: JSON.stringify({ ok: true, key: resolved.key }),
      };
    }
    case "sessions.patch": {
      if (!validateSessionsPatchParams(params)) {
        return {
          ok: false,
          error: {
            code: ErrorCodes.INVALID_REQUEST,
            message: `invalid sessions.patch params: ${formatValidationErrors(validateSessionsPatchParams.errors)}`,
          },
        };
      }

      const p = params as SessionsPatchParams;
      const key = String(p.key ?? "").trim();
      if (!key) {
        return {
          ok: false,
          error: {
            code: ErrorCodes.INVALID_REQUEST,
            message: "key required",
          },
        };
      }

      const cfg = loadConfig();
      const target = resolveGatewaySessionStoreTarget({ cfg, key });
      const storePath = target.storePath;
      const applied = await updateSessionStore(storePath, async (store) => {
        const primaryKey = target.storeKeys[0] ?? key;
        const existingKey = target.storeKeys.find((candidate) => store[candidate]);
        if (existingKey && existingKey !== primaryKey && !store[primaryKey]) {
          store[primaryKey] = store[existingKey];
          delete store[existingKey];
        }
        return await applySessionsPatchToStore({
          cfg,
          store,
          storeKey: primaryKey,
          patch: p,
          loadGatewayModelCatalog: ctx.loadGatewayModelCatalog,
        });
      });
      if (!applied.ok) {
        return {
          ok: false,
          error: {
            code: applied.error.code,
            message: applied.error.message,
            details: applied.error.details,
          },
        };
      }
      const payload: SessionsPatchResult = {
        ok: true,
        path: storePath,
        key: target.canonicalKey,
        entry: applied.entry,
      };
      return { ok: true, payloadJSON: JSON.stringify(payload) };
    }
    case "sessions.reset": {
      if (!validateSessionsResetParams(params)) {
        return {
          ok: false,
          error: {
            code: ErrorCodes.INVALID_REQUEST,
            message: `invalid sessions.reset params: ${formatValidationErrors(validateSessionsResetParams.errors)}`,
          },
        };
      }

      const p = params as SessionsResetParams;
      const key = String(p.key ?? "").trim();
      if (!key) {
        return {
          ok: false,
          error: {
            code: ErrorCodes.INVALID_REQUEST,
            message: "key required",
          },
        };
      }

      const cfg = loadConfig();
      const target = resolveGatewaySessionStoreTarget({ cfg, key });
      const storePath = target.storePath;
      const next = await updateSessionStore(storePath, (store) => {
        const primaryKey = target.storeKeys[0] ?? key;
        const existingKey = target.storeKeys.find((candidate) => store[candidate]);
        if (existingKey && existingKey !== primaryKey && !store[primaryKey]) {
          store[primaryKey] = store[existingKey];
          delete store[existingKey];
        }
        const entry = store[primaryKey];
        const now = Date.now();
        const nextEntry: SessionEntry = {
          sessionId: randomUUID(),
          updatedAt: now,
          systemSent: false,
          abortedLastRun: false,
          thinkingLevel: entry?.thinkingLevel,
          verboseLevel: entry?.verboseLevel,
          reasoningLevel: entry?.reasoningLevel,
          model: entry?.model,
          contextTokens: entry?.contextTokens,
          sendPolicy: entry?.sendPolicy,
          label: entry?.label,
          origin: snapshotSessionOrigin(entry),
          displayName: entry?.displayName,
          chatType: entry?.chatType,
          channel: entry?.channel,
          subject: entry?.subject,
          groupChannel: entry?.groupChannel,
          space: entry?.space,
          lastChannel: entry?.lastChannel,
          lastTo: entry?.lastTo,
          skillsSnapshot: entry?.skillsSnapshot,
        };
        store[primaryKey] = nextEntry;
        return nextEntry;
      });
      return {
        ok: true,
        payloadJSON: JSON.stringify({ ok: true, key, entry: next }),
      };
    }
    case "sessions.delete": {
      if (!validateSessionsDeleteParams(params)) {
        return {
          ok: false,
          error: {
            code: ErrorCodes.INVALID_REQUEST,
            message: `invalid sessions.delete params: ${formatValidationErrors(validateSessionsDeleteParams.errors)}`,
          },
        };
      }

      const p = params as SessionsDeleteParams;
      const key = String(p.key ?? "").trim();
      if (!key) {
        return {
          ok: false,
          error: {
            code: ErrorCodes.INVALID_REQUEST,
            message: "key required",
          },
        };
      }

      const mainKey = resolveMainSessionKeyFromConfig();
      if (key === mainKey) {
        return {
          ok: false,
          error: {
            code: ErrorCodes.INVALID_REQUEST,
            message: `Cannot delete the main session (${mainKey}).`,
          },
        };
      }

      const deleteTranscript = typeof p.deleteTranscript === "boolean" ? p.deleteTranscript : true;

      const cfg = loadConfig();
      const target = resolveGatewaySessionStoreTarget({ cfg, key });
      const storePath = target.storePath;
      const { entry } = loadSessionEntry(key);
      const sessionId = entry?.sessionId;
      clearCommandLane(resolveEmbeddedSessionLane(key));
      if (sessionId && isEmbeddedPiRunActive(sessionId)) {
        abortEmbeddedPiRun(sessionId);
        const ended = await waitForEmbeddedPiRunEnd(sessionId, 15_000);
        if (!ended) {
          return {
            ok: false,
            error: {
              code: ErrorCodes.UNAVAILABLE,
              message: `Session ${key} is still active; try again in a moment.`,
            },
          };
        }
      }
      const deletion = await updateSessionStore(storePath, (store) => {
        const primaryKey = target.storeKeys[0] ?? key;
        const existingKey = target.storeKeys.find((candidate) => store[candidate]);
        if (existingKey && existingKey !== primaryKey && !store[primaryKey]) {
          store[primaryKey] = store[existingKey];
          delete store[existingKey];
        }
        const entryToDelete = store[primaryKey];
        const existed = Boolean(entryToDelete);
        if (existed) delete store[primaryKey];
        return { existed, entry: entryToDelete };
      });
      const existed = deletion.existed;

      const archived: string[] = [];
      if (deleteTranscript && sessionId) {
        for (const candidate of resolveSessionTranscriptCandidates(
          sessionId,
          storePath,
          entry?.sessionFile,
        )) {
          if (!fs.existsSync(candidate)) continue;
          try {
            archived.push(archiveFileOnDisk(candidate, "deleted"));
          } catch {
            // Best-effort; deleting the store entry is the main operation.
          }
        }
      }

      return {
        ok: true,
        payloadJSON: JSON.stringify({
          ok: true,
          key,
          deleted: existed,
          archived,
        }),
      };
    }
    case "sessions.compact": {
      if (!validateSessionsCompactParams(params)) {
        return {
          ok: false,
          error: {
            code: ErrorCodes.INVALID_REQUEST,
            message: `invalid sessions.compact params: ${formatValidationErrors(validateSessionsCompactParams.errors)}`,
          },
        };
      }

      const p = params as SessionsCompactParams;
      const key = String(p.key ?? "").trim();
      if (!key) {
        return {
          ok: false,
          error: {
            code: ErrorCodes.INVALID_REQUEST,
            message: "key required",
          },
        };
      }

      const maxLines =
        typeof p.maxLines === "number" && Number.isFinite(p.maxLines)
          ? Math.max(1, Math.floor(p.maxLines))
          : 400;

      const cfg = loadConfig();
      const target = resolveGatewaySessionStoreTarget({ cfg, key });
      const storePath = target.storePath;
      // Resolve entry inside the lock, but compact outside to avoid holding it.
      const compactTarget = await updateSessionStore(storePath, (store) => {
        const primaryKey = target.storeKeys[0] ?? key;
        const existingKey = target.storeKeys.find((candidate) => store[candidate]);
        if (existingKey && existingKey !== primaryKey && !store[primaryKey]) {
          store[primaryKey] = store[existingKey];
          delete store[existingKey];
        }
        return { entry: store[primaryKey], primaryKey };
      });
      const entry = compactTarget.entry;
      const sessionId = entry?.sessionId;
      if (!sessionId) {
        return {
          ok: true,
          payloadJSON: JSON.stringify({
            ok: true,
            key,
            compacted: false,
            reason: "no sessionId",
          }),
        };
      }

      const filePath = resolveSessionTranscriptCandidates(
        sessionId,
        storePath,
        entry?.sessionFile,
      ).find((candidate) => fs.existsSync(candidate));
      if (!filePath) {
        return {
          ok: true,
          payloadJSON: JSON.stringify({
            ok: true,
            key,
            compacted: false,
            reason: "no transcript",
          }),
        };
      }

      const raw = fs.readFileSync(filePath, "utf-8");
      const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
      if (lines.length <= maxLines) {
        return {
          ok: true,
          payloadJSON: JSON.stringify({
            ok: true,
            key,
            compacted: false,
            kept: lines.length,
          }),
        };
      }

      const archived = archiveFileOnDisk(filePath, "bak");
      const keptLines = lines.slice(-maxLines);
      fs.writeFileSync(filePath, `${keptLines.join("\n")}\n`, "utf-8");

      // Token counts no longer match; clear so status + UI reflect reality after the next turn.
      await updateSessionStore(storePath, (store) => {
        const entryToUpdate = store[compactTarget.primaryKey];
        if (!entryToUpdate) return;
        delete entryToUpdate.inputTokens;
        delete entryToUpdate.outputTokens;
        delete entryToUpdate.totalTokens;
        entryToUpdate.updatedAt = Date.now();
      });

      return {
        ok: true,
        payloadJSON: JSON.stringify({
          ok: true,
          key,
          compacted: true,
          archived,
          kept: keptLines.length,
        }),
      };
    }
    default:
      return null;
  }
};
