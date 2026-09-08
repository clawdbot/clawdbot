export type SessionCleanupAction =
  | "keep"
  | "archive-dashboard"
  | "archive-cap"
  | "archive-age"
  | "prune-missing"
  | "prune-model-run"
  | "prune-stale"
  | "cap-overflow"
  | "retire-dm-scope";

/** Resolves the action label for one session key from cleanup key sets. */
export function resolveSessionCleanupAction(params: {
  key: string;
  missingKeys: Set<string>;
  modelRunPrunedKeys: Set<string>;
  archivedKeys?: Set<string>;
  capArchivedKeys?: Set<string>;
  ageArchivedKeys?: Set<string>;
  staleKeys: Set<string>;
  cappedKeys: Set<string>;
  dmScopeRetiredKeys: Set<string>;
}): SessionCleanupAction {
  if (params.dmScopeRetiredKeys.has(params.key)) {
    return "retire-dm-scope";
  }
  if (params.missingKeys.has(params.key)) {
    return "prune-missing";
  }
  if (params.modelRunPrunedKeys.has(params.key)) {
    return "prune-model-run";
  }
  if (params.archivedKeys?.has(params.key) || params.capArchivedKeys?.has(params.key)) {
    return params.archivedKeys?.has(params.key) ? "archive-dashboard" : "archive-cap";
  }
  if (params.ageArchivedKeys?.has(params.key)) {
    return "archive-age";
  }
  if (params.staleKeys.has(params.key)) {
    return "prune-stale";
  }
  if (params.cappedKeys.has(params.key)) {
    return "cap-overflow";
  }
  return "keep";
}
