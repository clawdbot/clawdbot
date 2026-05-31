import { sortUniqueStrings } from "../../../packages/normalization-core/src/string-normalization.js";

export function uniqueSortedStrings(values: readonly string[]) {
  return sortUniqueStrings(values);
}
