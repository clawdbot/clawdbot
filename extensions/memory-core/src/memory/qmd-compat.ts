export type QmdCollectionPatternFlag = "--glob" | "--mask";

export function resolveQmdCollectionPatternFlags(
  preferredFlag: QmdCollectionPatternFlag | null,
): QmdCollectionPatternFlag[] {
  return preferredFlag === "--mask" ? ["--mask", "--glob"] : ["--glob", "--mask"];
}
