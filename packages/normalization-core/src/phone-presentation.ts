import {
  getCountries,
  getCountryCallingCode,
  parsePhoneNumberFromString,
} from "libphonenumber-js/min";

const sharedCountryCallingCodes = (() => {
  const counts = new Map<string, number>();
  for (const country of getCountries()) {
    const callingCode = getCountryCallingCode(country);
    counts.set(callingCode, (counts.get(callingCode) ?? 0) + 1);
  }
  return new Set(
    [...counts.entries()].filter(([, count]) => count > 1).map(([callingCode]) => callingCode),
  );
})();

export function formatInternationalPhoneNumberForDisplay(
  raw: string,
  locale?: string,
): string | undefined {
  const candidate = raw.trim();
  if (!candidate.startsWith("+")) {
    return undefined;
  }

  try {
    const phoneNumber = parsePhoneNumberFromString(candidate, { extract: false });
    if (!phoneNumber?.isPossible()) {
      return undefined;
    }

    const international = phoneNumber.formatInternational();
    if (!phoneNumber.country || sharedCountryCallingCodes.has(phoneNumber.countryCallingCode)) {
      return international;
    }

    const countryName = new Intl.DisplayNames(locale ? [locale] : undefined, {
      type: "region",
    }).of(phoneNumber.country);
    return `${countryName || phoneNumber.country} · ${international}`;
  } catch {
    return undefined;
  }
}
