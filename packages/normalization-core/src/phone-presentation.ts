import { parsePhoneNumberFromString } from "libphonenumber-js/min";
import metadata from "libphonenumber-js/min/metadata";

const sharedCountryCallingCodes = new Set(
  Object.entries(metadata.country_calling_codes)
    .filter(([, countries]) => countries.length > 1)
    .map(([callingCode]) => callingCode),
);

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
