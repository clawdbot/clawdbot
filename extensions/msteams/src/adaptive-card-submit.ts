// Msteams helper module supports Adaptive Card submit payload behavior.
import {
  isRecord,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

function extractAdaptiveCardSubmittedData(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const action = isRecord(value.action) ? value.action : undefined;
  if (
    action &&
    normalizeOptionalLowercaseString(action.type) === "action.submit" &&
    "data" in action
  ) {
    return action.data;
  }
  return value;
}

function readMSTeamsImBackValue(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const msteams = isRecord(value.msteams) ? value.msteams : undefined;
  if (!msteams || normalizeOptionalLowercaseString(msteams.type) !== "imback") {
    return null;
  }
  return normalizeOptionalString(msteams.value) ?? null;
}

export function serializeMSTeamsAdaptiveCardActionValue(value: unknown): string | null {
  const submittedValue = extractAdaptiveCardSubmittedData(value);
  if (typeof submittedValue === "string") {
    const trimmed = submittedValue.trim();
    return trimmed ? trimmed : null;
  }
  const imBackValue = readMSTeamsImBackValue(submittedValue);
  if (imBackValue) {
    return imBackValue;
  }
  if (submittedValue == null) {
    return null;
  }
  try {
    return JSON.stringify(submittedValue);
  } catch {
    return null;
  }
}
