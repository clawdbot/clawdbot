import { diffLines } from "diff";

const CONTRACT_DIFF_LINE_LIMIT = 40;

/** Bounded unified-style preview of changed JSONL contract records. */
export type PluginSdkApiBaselineContractDiff = {
  /** Total added and removed JSONL lines. A modified record counts as two lines. */
  changedLineCount: number;
  /** Unified-style hunk headers and changed lines, capped for terminal output. */
  previewLines: string[];
  /** Number of added and removed lines included in the preview. */
  shownLineCount: number;
};

function describeContractLine(line: string): { identity: string | null; label: string } {
  try {
    const record = JSON.parse(line) as {
      entrypoint?: unknown;
    };
    if (typeof record.entrypoint === "string") {
      return {
        identity: `module\0${record.entrypoint}`,
        label: `entrypoint=${record.entrypoint}`,
      };
    }
  } catch {
    // Invalid committed JSONL still appears in the bounded raw-line diff.
  }
  return { identity: null, label: "unparseable record" };
}

export function diffPluginSdkApiBaselineContract(
  current: string | null,
  next: string,
): PluginSdkApiBaselineContractDiff {
  const changes = diffLines(current ?? "", next, { oneChangePerToken: true })
    .filter((change) => change.added || change.removed)
    .map((change) => {
      const line = change.value.replace(/(?:\r?\n)$/u, "");
      const description = describeContractLine(line);
      return {
        change,
        identity: description.identity,
        label: description.label,
        line,
      };
    });
  const addedIdentities = new Set(
    changes.flatMap(({ change, identity }) => (change.added && identity ? [identity] : [])),
  );
  const removedIdentities = new Set(
    changes.flatMap(({ change, identity }) => (change.removed && identity ? [identity] : [])),
  );
  const structuralChanges = new Set(
    changes.filter(
      ({ change, identity }) =>
        identity &&
        ((change.added && !removedIdentities.has(identity)) ||
          (change.removed && !addedIdentities.has(identity))),
    ),
  );
  const preview = [
    ...structuralChanges,
    ...changes.filter((change) => !structuralChanges.has(change)),
  ].slice(0, CONTRACT_DIFF_LINE_LIMIT);
  const previewLines = preview.flatMap(({ change, label, line }) => [
    `@@ ${label} @@`,
    `${change.added ? "+" : "-"}${line}`,
  ]);

  return {
    changedLineCount: changes.length,
    previewLines,
    shownLineCount: preview.length,
  };
}
