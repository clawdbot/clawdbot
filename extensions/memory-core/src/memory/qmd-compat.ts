// Memory Core plugin module implements qmd compat behavior.
export type QmdCollectionPatternFlag = "--glob" | "--mask";

export function resolveQmdCollectionPatternFlags(
  preferredFlag: QmdCollectionPatternFlag | null,
): QmdCollectionPatternFlag[] {
  return preferredFlag === "--glob" ? ["--glob", "--mask"] : ["--mask", "--glob"];
}
