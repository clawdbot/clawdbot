import { formatInternationalPhoneNumberForDisplay } from "@openclaw/normalization-core/phone-presentation";

export function formatPhoneNumberForCli(
  raw: string,
  options?: { allowInternationalDigits?: boolean },
): string {
  const trimmed = raw.trim();
  const candidate =
    options?.allowInternationalDigits === true && /^\d{7,15}$/u.test(trimmed) ? `+${trimmed}` : raw;
  const presentation = formatInternationalPhoneNumberForDisplay(candidate);
  return presentation && presentation !== raw ? `${presentation} (id: ${raw})` : raw;
}
