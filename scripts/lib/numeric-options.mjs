// Numeric CLI option parsers shared by script planning helpers.
/** Parse a safe positive integer option. */
export function parsePositiveInt(raw, label) {
  const text = String(raw).trim();
  if (!/^\d+$/u.test(text)) {
    throw new Error(`${label} must be a positive integer`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

/** Read a safe positive integer from an environment variable. */
export function readPositiveEnvInt(name, env, fallback) {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") {
    return fallback;
  }
  if (!/^[1-9]\d*$/u.test(raw)) {
    throw new Error(`invalid ${name}: ${raw}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`invalid ${name}: ${raw}`);
  }
  return value;
}

/** Parse a safe non-negative integer option. */
export function parseNonNegativeInt(raw, label) {
  const text = String(raw).trim();
  if (!/^\d+$/u.test(text)) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

/** Parse a finite positive number option. */
export function parsePositiveNumber(raw, label) {
  const text = String(raw).trim();
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/u.test(text)) {
    throw new Error(`${label} must be a positive number`);
  }
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return value;
}
