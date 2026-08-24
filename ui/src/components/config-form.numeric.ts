type DecimalRational = {
  numerator: bigint;
  denominator: bigint;
};

const CONFIG_FORM_DECIMAL_NUMBER_RE = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;
const MAX_CONFIG_FORM_DECIMAL_RATIONAL_DIGITS = 1024;

function decimalStringRational(value: string): DecimalRational | undefined {
  if (!CONFIG_FORM_DECIMAL_NUMBER_RE.test(value)) {
    return undefined;
  }
  const [coefficientText = "", exponentText] = value.toLowerCase().split("e");
  const negative = coefficientText.startsWith("-");
  const coefficient = negative ? coefficientText.slice(1) : coefficientText;
  const [wholeText = "", fraction = ""] = coefficient.split(".");
  const whole = wholeText || "0";
  const digitsText = `${whole}${fraction}`;
  if (/^0+$/u.test(digitsText)) {
    return { numerator: 0n, denominator: 1n };
  }
  const exponent = Number(exponentText ?? 0);
  if (!Number.isSafeInteger(exponent)) {
    return undefined;
  }
  const fractionalPlaces = fraction.length - exponent;
  if (
    digitsText.length > MAX_CONFIG_FORM_DECIMAL_RATIONAL_DIGITS ||
    Math.abs(fractionalPlaces) > MAX_CONFIG_FORM_DECIMAL_RATIONAL_DIGITS
  ) {
    return undefined;
  }
  const digits = BigInt(digitsText);
  const numerator = fractionalPlaces < 0 ? digits * 10n ** BigInt(-fractionalPlaces) : digits;
  return {
    numerator: negative ? -numerator : numerator,
    denominator: fractionalPlaces > 0 ? 10n ** BigInt(fractionalPlaces) : 1n,
  };
}

function decimalRationalsEqual(left: DecimalRational, right: DecimalRational): boolean {
  return left.numerator * right.denominator === right.numerator * left.denominator;
}

export function isConfigFormDecimalNumberString(value: string): boolean {
  const trimmed = value.trim();
  return trimmed !== "" && CONFIG_FORM_DECIMAL_NUMBER_RE.test(trimmed);
}

export function isConfigFormUnsafeIntegerString(value: string): boolean {
  const trimmed = value.trim();
  return /^-?\d+$/u.test(trimmed) && !Number.isSafeInteger(Number(trimmed));
}

export function coerceConfigFormNumberString(
  value: string,
  integer: boolean,
): number | undefined | string {
  const trimmed = value.trim();
  if (trimmed === "") {
    return undefined;
  }
  if (!isConfigFormDecimalNumberString(trimmed)) {
    return value;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || (integer && !Number.isInteger(parsed))) {
    return value;
  }
  const authored = decimalStringRational(trimmed);
  if (!authored) {
    return value;
  }
  const decimalSpelling = Number.isInteger(parsed) ? undefined : decimalRational(parsed);
  // Integer-valued doubles need bit-exact comparison: shortest-decimal output
  // can hide a rounded integer. Fractional values retain decimal-spelling
  // comparison so ordinary JSON decimals such as 0.10 keep their old type.
  const matchesRepresentedValue = Number.isInteger(parsed)
    ? authored.numerator === BigInt(parsed) * authored.denominator
    : decimalSpelling && decimalRationalsEqual(authored, decimalSpelling);
  if (!matchesRepresentedValue) {
    return value;
  }
  return parsed;
}

export function formatConfigFormNumber(value: number): string {
  return Number.isInteger(value) ? BigInt(value).toString() : String(value);
}

// Keep this decimal-spelling form for JSON Schema step arithmetic; scalar
// integer coercion uses BigInt above to detect hidden rounding.
export function decimalRational(value: number): DecimalRational | undefined {
  if (!Number.isFinite(value)) {
    return undefined;
  }
  return decimalStringRational(String(value));
}
