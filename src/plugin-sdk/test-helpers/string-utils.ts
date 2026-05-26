import { sortUniqueStrings } from "../../shared/string-normalization.js";

export function uniqueSortedStrings(values: readonly string[]) {
  return sortUniqueStrings(values);
}
