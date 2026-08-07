import { isSensitiveFieldKey, redactSensitiveText } from "../logging/redact.js";

export const CLAW_SETUP_SECRET_REJECTION_MESSAGE =
  "Claw setup cannot collect credentials. Configure credentials with an existing SecretRef or auth profile instead.";

function normalizedLabelKey(label: string | undefined): string {
  return label?.trim().replaceAll(/[^A-Za-z0-9]+/g, "-") ?? "";
}

export function isSensitiveClawSetupField(params: { id: string; label?: string }): boolean {
  return (
    isSensitiveFieldKey(params.id) ||
    (normalizedLabelKey(params.label) !== "" &&
      isSensitiveFieldKey(normalizedLabelKey(params.label)))
  );
}

export function containsSensitiveClawSetupValue(value: unknown): boolean {
  if (typeof value === "string") {
    return redactSensitiveText(value, { mode: "tools" }) !== value;
  }
  return Array.isArray(value) && value.some((entry) => containsSensitiveClawSetupValue(entry));
}
