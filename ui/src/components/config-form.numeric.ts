type DecimalRational = {
  numerator: bigint;
  denominator: bigint;
};

const CONFIG_FORM_DECIMAL_NUMBER_RE = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;
const MAX_CONFIG_FORM_DECIMAL_RATIONAL_DIGITS = 1024;
const DOUBLE_FRACTION_BITS = 52n;
const DOUBLE_FRACTION_MASK = (1n << DOUBLE_FRACTION_BITS) - 1n;
const DOUBLE_EXPONENT_MASK = 0x7ffn;
const DOUBLE_EXPONENT_BIAS = 1023;
const DOUBLE_SIGN_MASK = 1n << 63n;
const DOUBLE_SUBNORMAL_DENOMINATOR = 2n ** 1074n;
const DOUBLE_BITS_VIEW = new DataView(new ArrayBuffer(8));

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
  const represented = binaryDoubleRational(parsed);
  const decimalSpelling = Number.isInteger(parsed) ? undefined : decimalRational(parsed);
  // Integer-valued doubles need bit-exact comparison: shortest-decimal output
  // can hide a rounded integer. Fractional values retain decimal-spelling
  // comparison so ordinary JSON decimals such as 0.10 keep their old type.
  const matchesRepresentedValue = Number.isInteger(parsed)
    ? represented && decimalRationalsEqual(authored, represented)
    : decimalSpelling && decimalRationalsEqual(authored, decimalSpelling);
  if (!matchesRepresentedValue) {
    return value;
  }
  return parsed;
}

function binaryDoubleRational(value: number): DecimalRational | undefined {
  if (!Number.isFinite(value)) {
    return undefined;
  }
  DOUBLE_BITS_VIEW.setFloat64(0, value);
  const bits = DOUBLE_BITS_VIEW.getBigUint64(0);
  const negative = (bits & DOUBLE_SIGN_MASK) !== 0n;
  const fraction = bits & DOUBLE_FRACTION_MASK;
  const exponentBits = Number((bits >> DOUBLE_FRACTION_BITS) & DOUBLE_EXPONENT_MASK);
  if (exponentBits === 0) {
    if (fraction === 0n) {
      return { numerator: 0n, denominator: 1n };
    }
    return {
      numerator: negative ? -fraction : fraction,
      denominator: DOUBLE_SUBNORMAL_DENOMINATOR,
    };
  }

  const significand = (1n << DOUBLE_FRACTION_BITS) | fraction;
  const exponent = exponentBits - DOUBLE_EXPONENT_BIAS - Number(DOUBLE_FRACTION_BITS);
  if (exponent >= 0) {
    const numerator = significand * 2n ** BigInt(exponent);
    return { numerator: negative ? -numerator : numerator, denominator: 1n };
  }
  return {
    numerator: negative ? -significand : significand,
    denominator: 2n ** BigInt(-exponent),
  };
}

// Keep this decimal-spelling form for JSON Schema step arithmetic; scalar
// integer coercion uses binaryDoubleRational above to detect hidden rounding.
export function decimalRational(value: number): DecimalRational | undefined {
  if (!Number.isFinite(value)) {
    return undefined;
  }
  return decimalStringRational(String(value));
}
