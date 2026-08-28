// Text input coercion and validation helpers for scalar config form nodes.
import { t } from "../i18n/index.ts";
import { isSupportedConfigValueValid } from "./config-form.constraints.ts";
import type { ConfigNodeRenderParams } from "./config-form.node.shared.ts";
import {
  coerceConfigFormNumberString,
  isConfigFormDecimalNumberString,
  isConfigFormUnsafeIntegerString,
} from "./config-form.numeric.ts";
import { scalarValueBranch, type ScalarEditHint } from "./config-form.scalar-edit.ts";
import { schemaType } from "./config-form.shared.ts";

export function coerceTextInputValue(
  value: string,
  schema: ConfigNodeRenderParams["schema"],
  currentValue?: unknown,
  editHint?: ScalarEditHint,
): string | number | boolean | undefined {
  const trimmed = value.trim();
  const variants = schema.anyOf ?? schema.oneOf ?? [];
  const stringCandidateValid = isSupportedConfigValueValid(schema, value);
  const currentBranch = editHint ? editHint.branch : scalarValueBranch(currentValue);
  const booleanCandidate = trimmed === "true" ? true : trimmed === "false" ? false : undefined;
  if (booleanCandidate !== undefined && isSupportedConfigValueValid(schema, booleanCandidate)) {
    let booleanBranchValid = false;
    let explicitBooleanBranchValid = false;
    for (const variant of variants) {
      const booleanBranch =
        schemaType(variant) === "boolean" ||
        typeof variant.const === "boolean" ||
        variant.enum?.some((entry) => typeof entry === "boolean");
      if (!booleanBranch || !isSupportedConfigValueValid(variant, booleanCandidate)) {
        continue;
      }
      booleanBranchValid = true;
      explicitBooleanBranchValid ||=
        Object.is(variant.const, booleanCandidate) ||
        Boolean(variant.enum?.some((entry) => Object.is(entry, booleanCandidate)));
    }
    if (
      booleanBranchValid &&
      (currentBranch !== "string" || explicitBooleanBranchValid || !stringCandidateValid)
    ) {
      return booleanCandidate;
    }
  }
  let numberCandidate: number | undefined;
  for (const variant of variants) {
    const type = schemaType(variant);
    if (type !== "number" && type !== "integer") {
      continue;
    }
    const candidate = coerceConfigFormNumberString(value, type === "integer");
    if (typeof candidate === "number" && isSupportedConfigValueValid(schema, candidate)) {
      numberCandidate = candidate;
      break;
    }
  }
  if (currentBranch === "number") {
    if (numberCandidate !== undefined) {
      return numberCandidate;
    }
    if (isConfigFormDecimalNumberString(value)) {
      return stringCandidateValid && isConfigFormUnsafeIntegerString(trimmed) ? value : undefined;
    }
  }
  if (currentBranch === "string" && stringCandidateValid) {
    return value;
  }
  if (numberCandidate !== undefined) {
    return numberCandidate;
  }
  if (stringCandidateValid) {
    return value;
  }
  return value;
}

export function stringConstraintMessage(
  value: string,
  schema: ConfigNodeRenderParams["schema"],
  currentValue?: unknown,
  editHint?: ScalarEditHint,
): string {
  return isSupportedConfigValueValid(
    schema,
    coerceTextInputValue(value, schema, currentValue, editHint),
  )
    ? ""
    : t("configForm.invalidString");
}

export function shouldClearOptionalEmpty(
  value: string,
  schema: ConfigNodeRenderParams["schema"],
  isRequired: boolean,
  currentValue?: unknown,
  editHint?: ScalarEditHint,
): boolean {
  return (
    value === "" &&
    !isRequired &&
    Boolean(stringConstraintMessage(value, schema, currentValue, editHint))
  );
}
