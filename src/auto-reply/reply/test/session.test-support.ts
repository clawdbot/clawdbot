// Shared store and reset fixtures for session.test.ts.
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../../../config/config.js";
import type { InternalSessionEntry as SessionEntry } from "../../../config/sessions.js";
import {
  listSessionEntries,
  loadSessionEntry,
  replaceSessionEntry,
  upsertSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { normalizeLegacySessionEntryDelivery } from "../../../infra/state-migrations.legacy-session-store.js";
import { projectSessionDeliveryFields } from "../../../utils/delivery-context.shared.js";
import { finalizeInboundContext } from "../inbound-context.js";
import { initSessionState as initSessionStateRaw } from "../session.js";

type ProjectedSessionEntry = SessionEntry & ReturnType<typeof projectSessionDeliveryFields>;

function projectSessionEntry(entry: SessionEntry): ProjectedSessionEntry {
  return { ...entry, ...projectSessionDeliveryFields(entry.delivery) };
}

export const initSessionState = async (
  params: Omit<Parameters<typeof initSessionStateRaw>[0], "ctx"> & {
    ctx: Record<string, unknown>;
  },
) => {
  const result = await initSessionStateRaw({ ...params, ctx: finalizeInboundContext(params.ctx) });
  return { ...result, sessionEntry: projectSessionEntry(result.sessionEntry) };
};

export async function writeSessionStore(
  storePath: string,
  store: Record<string, SessionEntry | Record<string, unknown>>,
): Promise<void> {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  for (const [sessionKey, entry] of Object.entries(store)) {
    const patch = entry as Partial<SessionEntry>;
    const canonical = normalizeLegacySessionEntryDelivery(patch as SessionEntry);
    if (typeof patch.sessionId === "string" && patch.sessionId.trim()) {
      await replaceSessionEntry({ storePath, sessionKey }, canonical);
    } else {
      await upsertSessionEntry({ storePath, sessionKey }, canonical);
    }
  }
}

export function readSessionStore(storePath: string): Record<string, ProjectedSessionEntry> {
  const entries = Object.fromEntries(
    listSessionEntries({ storePath }).map(({ sessionKey, entry }) => [
      sessionKey,
      projectSessionEntry(entry),
    ]),
  ) as Record<string, ProjectedSessionEntry>;
  return new Proxy(entries, {
    get(target, prop, receiver) {
      if (typeof prop !== "string" || prop in target) {
        return Reflect.get(target, prop, receiver);
      }
      const entry = loadSessionEntry({ storePath, sessionKey: prop, readConsistency: "latest" });
      if (entry) {
        target[prop] = projectSessionEntry(entry);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

export async function runExplicitResetCases(params: {
  storePath: string;
  sessionKey: string;
  sessionId: string;
  entry?: Record<string, unknown>;
  ctx?: Record<string, unknown>;
  cfg?: Omit<OpenClawConfig, "session">;
}) {
  const results = [];
  for (const testCase of [
    { name: "new", body: "/new" },
    { name: "reset", body: "/reset" },
  ] as const) {
    await writeSessionStore(params.storePath, {
      [params.sessionKey]: {
        sessionId: params.sessionId,
        updatedAt: Date.now(),
        ...params.entry,
      },
    });
    const result = await initSessionState({
      ctx: {
        Body: testCase.body,
        RawBody: testCase.body,
        CommandBody: testCase.body,
        From: "reset-user",
        To: "bot",
        ChatType: "direct",
        SessionKey: params.sessionKey,
        Provider: "telegram",
        Surface: "telegram",
        ...params.ctx,
      },
      cfg: {
        ...params.cfg,
        session: { store: params.storePath, idleMinutes: 999 },
      } as OpenClawConfig,
      commandAuthorized: true,
    });
    results.push({ ...testCase, result, stored: readSessionStore(params.storePath) });
  }
  return results;
}
