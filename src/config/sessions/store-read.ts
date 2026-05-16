import fs from "node:fs";
import { z } from "zod";
import { safeParseJsonWithSchema } from "../../utils/zod-parse.js";
import { normalizePersistedSessionEntryShape } from "./store-entry-shape.js";
import type { SessionEntry } from "./types.js";

const SessionStoreSchema = z.record(z.string(), z.unknown()) as z.ZodType<
  Record<string, SessionEntry | undefined>
>;

export function readSessionStoreReadOnly(
  storePath: string,
): Record<string, SessionEntry | undefined> {
  try {
    const raw = fs.readFileSync(storePath, "utf-8");
    if (!raw.trim()) {
      return {};
    }
    const parsed = safeParseJsonWithSchema(SessionStoreSchema, raw) ?? {};
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([key, entry]) => {
        const normalized = normalizePersistedSessionEntryShape(entry);
        return normalized ? [[key, normalized]] : [];
      }),
    );
  } catch {
    return {};
  }
}
