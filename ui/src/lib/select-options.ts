// Control UI module implements select options behavior.
import { normalizeLowercaseStringOrEmpty } from "./string-coerce.ts";

type SelectOption = {
  value: string;
  label: string;
};

export function pushUniqueTrimmedSelectOption(
  options: SelectOption[],
  seen: Set<string>,
  value: string,
  labelForValue: (trimmed: string) => string,
) {
  const trimmed = value.trim();
  if (!trimmed) {
    return;
  }
  const key = normalizeLowercaseStringOrEmpty(trimmed);
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  options.push({ value: trimmed, label: labelForValue(trimmed) });
}
