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
  const exponent = Number(exponentText ?? 0);
  if (!Number.isSafeInteger(exponent)) {
    return undefined;
  }
  const negative = coefficientText.startsWith("-");
  const coefficient = negative ? coefficientText.slice(1) : coefficientText;
  const [wholeText = "", fraction = ""] = coefficient.split(".");
  const whole = wholeText || "0";
  const digitsText = `${whole}${fraction}`;
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

export function coerceConfigFormNumberString(
  value: string,
  integer: boolean,
): number | undefined | string {
  const trimmed = value.trim();
  if (trimmed === "") {
    return undefined;
  }
  if (!CONFIG_FORM_DECIMAL_NUMBER_RE.test(trimmed)) {
    return value;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || (integer && !Number.isInteger(parsed))) {
    return value;
  }
  const authored = decimalStringRational(trimmed);
  const represented = decimalRational(parsed);
  if (!authored || !represented || !decimalRationalsEqual(authored, represented)) {
    return value;
  }
  // JSON numbers cannot safely carry integer magnitudes beyond 2^53, even
  // when the input used exponent or fractional notation.
  if (Number.isInteger(parsed) && !Number.isSafeInteger(parsed)) {
    return value;
  }
  return parsed;
}

export function decimalRational(value: number): DecimalRational | undefined {
  if (!Number.isFinite(value)) {
    return undefined;
  }
  return decimalStringRational(String(value));
}
