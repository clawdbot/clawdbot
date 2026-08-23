type DecimalRational = {
  numerator: bigint;
  denominator: bigint;
};

const CONFIG_FORM_DECIMAL_NUMBER_RE = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;

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
  return parsed;
}

export function decimalRational(value: number): DecimalRational | undefined {
  if (!Number.isFinite(value)) {
    return undefined;
  }
  const [coefficientText = "", exponentText] = String(value).toLowerCase().split("e");
  const negative = coefficientText.startsWith("-");
  const coefficient = negative ? coefficientText.slice(1) : coefficientText;
  const [whole = "0", fraction = ""] = coefficient.split(".");
  const exponent = Number(exponentText ?? 0);
  const digits = BigInt(`${whole}${fraction}`);
  const fractionalPlaces = fraction.length - exponent;
  const numerator = fractionalPlaces < 0 ? digits * 10n ** BigInt(-fractionalPlaces) : digits;
  return {
    numerator: negative ? -numerator : numerator,
    denominator: fractionalPlaces > 0 ? 10n ** BigInt(fractionalPlaces) : 1n,
  };
}
