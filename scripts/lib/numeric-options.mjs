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
