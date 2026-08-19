import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { listSecretStoreEntries, readSecretStoreValue } from "./store/secret-store.js";

export type PlaintextAssignment = {
  file: string;
  path: string;
  value: string;
};

export function findSecretStorePlaintextResidueFindings(params: {
  assignments: PlaintextAssignment[];
  database: OpenClawStateDatabaseOptions;
}): Array<{
  code: "STORE_PLAINTEXT_RESIDUE";
  severity: "warn";
  file: string;
  jsonPath: string;
  message: string;
}> {
  const entries = listSecretStoreEntries({
    scope: { kind: "team" },
    database: params.database,
  });
  if (entries.length === 0 || params.assignments.length === 0) {
    return [];
  }
  const namesByValue = new Map<string, string[]>();
  for (const entry of entries) {
    const result = readSecretStoreValue({
      scope: { kind: "team" },
      name: entry.name,
      database: params.database,
    });
    if (!result.ok) {
      if (result.error.code === "SECRET_STORE_NOT_FOUND") {
        continue;
      }
      if (result.error.code === "SECRET_STORE_INVALID_NAME") {
        throw new Error(result.error.message);
      }
      throw new Error(result.error.message, { cause: result.error.cause });
    }
    const names = namesByValue.get(result.value);
    if (names) {
      names.push(entry.name);
    } else {
      namesByValue.set(result.value, [entry.name]);
    }
  }
  return params.assignments.flatMap((assignment) =>
    (namesByValue.get(assignment.value) ?? []).map((name) => ({
      code: "STORE_PLAINTEXT_RESIDUE" as const,
      severity: "warn" as const,
      file: assignment.file,
      jsonPath: assignment.path,
      message: `${assignment.path} duplicates team secret store entry "${name}"; replace the plaintext with a store SecretRef.`,
    })),
  );
}
