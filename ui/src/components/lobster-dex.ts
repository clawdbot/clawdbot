// The Lobsterdex: a quiet localStorage log of every lobster palette that has
// ever visited this browser, remembering who came first and when. Also home
// to the familiarity counters the pet uses to warm up to (or grow wary of)
// its human. Purely client-side; string-keyed so this stays a leaf module
// (the pet imports us; importing pet types back would create an import
// cycle).
import { getSafeLocalStorage } from "../local-storage.ts";

const LOBSTERDEX_KEY = "openclaw.control.lobsterdex.v1";
const FAMILIARITY_KEY = "openclaw.control.lobsterpet.familiarity.v1";

export type LobsterdexEntry = {
  firstSeenAt: number | null;
  name: string | null;
};

type PersistedDex = Record<string, { firstSeenAt?: number; name?: string }>;

function readDex(): Map<string, LobsterdexEntry> {
  try {
    const raw = getSafeLocalStorage()?.getItem(LOBSTERDEX_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    const entries = new Map<string, LobsterdexEntry>();
    if (Array.isArray(parsed)) {
      // v1 stored a bare palette-id array; carry ids over without memories.
      for (const value of parsed) {
        if (typeof value === "string" && value) {
          entries.set(value, { firstSeenAt: null, name: null });
        }
      }
      return entries;
    }
    if (parsed && typeof parsed === "object") {
      for (const [id, value] of Object.entries(parsed as PersistedDex)) {
        if (!id) {
          continue;
        }
        entries.set(id, {
          firstSeenAt: typeof value?.firstSeenAt === "number" ? value.firstSeenAt : null,
          name: typeof value?.name === "string" && value.name ? value.name : null,
        });
      }
    }
    return entries;
  } catch {
    return new Map();
  }
}

function writeDex(entries: Map<string, LobsterdexEntry>): void {
  const persisted: PersistedDex = {};
  for (const [id, entry] of [...entries.entries()].toSorted(([a], [b]) => a.localeCompare(b))) {
    persisted[id] = {
      ...(entry.firstSeenAt !== null ? { firstSeenAt: entry.firstSeenAt } : {}),
      ...(entry.name !== null ? { name: entry.name } : {}),
    };
  }
  getSafeLocalStorage()?.setItem(LOBSTERDEX_KEY, JSON.stringify(persisted));
}

export function getLobsterdex(): ReadonlySet<string> {
  return new Set(readDex().keys());
}

export function getLobsterdexEntries(): ReadonlyMap<string, LobsterdexEntry> {
  return readDex();
}

export function recordLobsterVisit(paletteId: string, details: { name?: string } = {}): void {
  try {
    const entries = readDex();
    const existing = entries.get(paletteId);
    if (existing) {
      // First-visitor memories are immutable; later visits only backfill
      // fields the v1 schema never had.
      if (existing.firstSeenAt !== null && existing.name !== null) {
        return;
      }
      entries.set(paletteId, {
        firstSeenAt: existing.firstSeenAt ?? Date.now(),
        name: existing.name ?? details.name ?? null,
      });
    } else {
      entries.set(paletteId, { firstSeenAt: Date.now(), name: details.name ?? null });
    }
    writeDex(entries);
  } catch {
    // best-effort — a full or blocked storage must not break visits
  }
}

// ---- Familiarity ----

export type LobsterFamiliarityTier = "shy" | "regular" | "friend";

export type LobsterFamiliarity = {
  tier: LobsterFamiliarityTier;
  wary: boolean;
  visits: number;
  shoos: number;
};

// Behavior multipliers per tier; the pet reads these once per load. Shy pets
// keep visits short and arrive late; friends linger, return sooner, and
// greet. Wary pets (shooed too often) leave longer gaps between visits.
export const LOBSTER_FAMILIARITY_TUNING = {
  shy: { stayMul: 0.6, firstDelayMul: 1.3, gapMul: 1 },
  regular: { stayMul: 1, firstDelayMul: 1, gapMul: 1 },
  friend: { stayMul: 1.6, firstDelayMul: 0.7, gapMul: 0.8 },
  waryGapMul: 1.7,
} as const;

function readFamiliarityCounters(): { visits: number; shoos: number } {
  try {
    const raw = getSafeLocalStorage()?.getItem(FAMILIARITY_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    const record = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    const visits = typeof record.visits === "number" && record.visits >= 0 ? record.visits : 0;
    const shoos = typeof record.shoos === "number" && record.shoos >= 0 ? record.shoos : 0;
    return { visits, shoos };
  } catch {
    return { visits: 0, shoos: 0 };
  }
}

function writeFamiliarityCounters(counters: { visits: number; shoos: number }): void {
  try {
    getSafeLocalStorage()?.setItem(FAMILIARITY_KEY, JSON.stringify(counters));
  } catch {
    // best-effort
  }
}

export function recordLobsterArrivalStats(): void {
  const counters = readFamiliarityCounters();
  writeFamiliarityCounters({ ...counters, visits: counters.visits + 1 });
}

export function recordLobsterShoo(): void {
  const counters = readFamiliarityCounters();
  writeFamiliarityCounters({ ...counters, shoos: counters.shoos + 1 });
}

export function getLobsterFamiliarity(): LobsterFamiliarity {
  const { visits, shoos } = readFamiliarityCounters();
  const tier: LobsterFamiliarityTier = visits < 3 ? "shy" : visits < 15 ? "regular" : "friend";
  const wary = shoos >= 3 && shoos > visits * 0.3;
  return { tier, wary, visits, shoos };
}
