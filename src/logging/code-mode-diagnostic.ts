import { isTruthyEnvValue } from "../infra/env.js";
import { redactToolPayloadText } from "./redact.js";
import type { SubsystemLogger } from "./subsystem.js";

const MAX_NAMES = 24;
const MAX_NAME_LENGTH = 80;

type CodeModeDiagnosticFields = Record<
  string,
  boolean | number | string | readonly string[] | undefined
>;

export function isCodeModeDiagnosticEnabled(): boolean {
  return isTruthyEnvValue(process.env.OPENCLAW_DEBUG_CODE_MODE);
}

export function logCodeModeDiagnostic(
  log: Pick<SubsystemLogger, "info">,
  boundary: string,
  fields: CodeModeDiagnosticFields,
): void {
  if (!isCodeModeDiagnosticEnabled()) {
    return;
  }
  const bounded = Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      Array.isArray(value)
        ? [...new Set(value.map((name) => name.slice(0, MAX_NAME_LENGTH)))]
            .toSorted((left, right) => left.localeCompare(right))
            .slice(0, MAX_NAMES)
        : typeof value === "string"
          ? value.slice(0, MAX_NAME_LENGTH)
          : value,
    ]),
  );
  log.info(
    redactToolPayloadText(`code-mode diagnostic ${JSON.stringify({ boundary, ...bounded })}`),
  );
}
