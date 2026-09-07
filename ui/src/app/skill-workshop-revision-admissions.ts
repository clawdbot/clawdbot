import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import { generateUUID } from "../lib/uuid.ts";

export type SkillWorkshopRevisionAdmissionInput = {
  expectedRevisionHash?: string;
  instructions: string;
  proposalAgentId: string;
  proposalId: string;
  proposalOriginAgentId?: string;
  proposalOriginSessionKey?: string;
  proposalSlug: string;
};

export type SkillWorkshopRevisionAdmissionBinding = {
  expectedRevisionHash: string;
  proposalOriginAgentId?: string;
  proposalOriginSessionKey?: string;
};

export type SkillWorkshopRevisionAdmissionEntry = SkillWorkshopRevisionAdmissionInput & {
  error?: string;
  id: string;
  idempotencyKey: string;
  phase: "pending" | "retryable-failed";
};

export type SkillWorkshopRevisionAdmissionOutcome =
  | { id: string; sessionKey: string; status: "admitted" }
  | { id: string; status: "revision-changed" }
  | { error: string; id: string; status: "retryable-failed" };

type AdmissionExecutorResult =
  | { sessionKey: string; status: "admitted" }
  | { status: "revision-changed" };

type AdmissionExecutor = (
  entry: SkillWorkshopRevisionAdmissionEntry,
  materialize: (
    binding: SkillWorkshopRevisionAdmissionBinding,
  ) => SkillWorkshopRevisionAdmissionEntry | null,
) => Promise<AdmissionExecutorResult>;

type SkillWorkshopRevisionAdmissionRun = {
  completion: Promise<SkillWorkshopRevisionAdmissionOutcome>;
  entry: SkillWorkshopRevisionAdmissionEntry;
};

export type ApplicationSkillWorkshopRevisionAdmissions = {
  dispose(): void;
  firstFailed(proposalAgentId: string): SkillWorkshopRevisionAdmissionEntry | null;
  get(id: string): SkillWorkshopRevisionAdmissionEntry | null;
  retry(id: string): SkillWorkshopRevisionAdmissionRun | null;
  start(
    input: SkillWorkshopRevisionAdmissionInput,
    execute: AdmissionExecutor,
  ): SkillWorkshopRevisionAdmissionRun;
  subscribe(listener: () => void): () => void;
};

type OwnedEntry = {
  execute: AdmissionExecutor;
  generation: number;
  value: SkillWorkshopRevisionAdmissionEntry;
};

function copyEntry(entry: OwnedEntry): SkillWorkshopRevisionAdmissionEntry {
  return { ...entry.value };
}

export function createSkillWorkshopRevisionAdmissions(): ApplicationSkillWorkshopRevisionAdmissions {
  const entries = new Map<string, OwnedEntry>();
  const listeners = new Set<() => void>();
  let disposed = false;

  const publish = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  const run = (entry: OwnedEntry): SkillWorkshopRevisionAdmissionRun => {
    const generation = entry.generation;
    const materialize = (binding: SkillWorkshopRevisionAdmissionBinding) => {
      if (
        disposed ||
        entries.get(entry.value.id) !== entry ||
        entry.generation !== generation ||
        entry.value.phase !== "pending"
      ) {
        return null;
      }
      entry.value = { ...entry.value, ...binding };
      publish();
      return copyEntry(entry);
    };
    const completion = entry
      .execute(copyEntry(entry), materialize)
      .then((result): SkillWorkshopRevisionAdmissionOutcome => {
        if (entries.get(entry.value.id) === entry && entry.generation === generation) {
          entries.delete(entry.value.id);
          publish();
        }
        return result.status === "admitted"
          ? { id: entry.value.id, sessionKey: result.sessionKey, status: "admitted" }
          : { id: entry.value.id, status: "revision-changed" };
      })
      .catch((error: unknown): SkillWorkshopRevisionAdmissionOutcome => {
        const message = error instanceof Error ? error.message : String(error);
        if (entries.get(entry.value.id) === entry && entry.generation === generation) {
          entry.value = { ...entry.value, error: message, phase: "retryable-failed" };
          publish();
        }
        return { error: message, id: entry.value.id, status: "retryable-failed" };
      });
    return { completion, entry: copyEntry(entry) };
  };

  return {
    start(input, execute) {
      const id = generateUUID();
      const entry: OwnedEntry = {
        execute,
        generation: 0,
        value: {
          ...input,
          id,
          idempotencyKey: generateUUID(),
          phase: "pending",
        },
      };
      if (disposed) {
        throw new Error("Skill Workshop revision admission owner is disposed.");
      }
      entries.set(id, entry);
      publish();
      return run(entry);
    },
    retry(id) {
      const entry = entries.get(id);
      if (!entry || entry.value.phase !== "retryable-failed" || disposed) {
        return null;
      }
      entry.generation += 1;
      entry.value = { ...entry.value, error: undefined, phase: "pending" };
      publish();
      return run(entry);
    },
    get(id) {
      const entry = entries.get(id);
      return entry ? copyEntry(entry) : null;
    },
    firstFailed(proposalAgentId) {
      const normalizedAgentId = normalizeAgentId(proposalAgentId);
      for (const entry of entries.values()) {
        if (
          entry.value.phase === "retryable-failed" &&
          normalizeAgentId(entry.value.proposalAgentId) === normalizedAgentId
        ) {
          return copyEntry(entry);
        }
      }
      return null;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      entries.clear();
      listeners.clear();
    },
  };
}
