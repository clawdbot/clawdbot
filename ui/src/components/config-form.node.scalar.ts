// Control UI renderers for scalar config form nodes.
import { formatInternationalPhoneNumberForDisplay } from "@openclaw/normalization-core/phone-presentation";
import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { i18n, t } from "../i18n/index.ts";
import {
  isSupportedConfigValueValid,
  normalizeNumericValue,
  numericInputConstraints,
} from "./config-form.constraints.ts";
import {
  configEnumOptionLabel,
  formatConfigValueText,
  getSensitiveRenderState,
  isSecretRefObject,
  jsonValue,
  renderFieldRow,
  renderSchemaDefaultDescription,
  renderSensitiveToggleButton,
  wrapSensitiveControl,
  type ConfigNodeRenderParams,
} from "./config-form.node.shared.ts";
import {
  coerceConfigFormNumberString,
  isConfigFormDecimalNumberString,
  isConfigFormUnsafeIntegerString,
} from "./config-form.numeric.ts";
import {
  beginScalarEdit,
  finishScalarEdit,
  finishScalarEditFromEvent,
  scalarEditHintForInput,
  scalarValueBranch,
  syncScalarEditIdentity,
  type ScalarEditHint,
} from "./config-form.scalar-edit.ts";
import { resolveConfigFieldMeta as resolveFieldMeta } from "./config-form.search.ts";
import {
  configFieldId,
  hintForPath,
  redactedPlaceholder,
  schemaType,
} from "./config-form.shared.ts";

const scalarInputState = new WeakMap<
  HTMLInputElement,
  {
    controlIdentity: unknown;
    sourceIdentity: unknown;
    rowIdentity: unknown;
    pathKey: string;
    presentationIdentity: string;
    renderedValue: string;
  }
>();

function setControlValidity(target: HTMLInputElement, message: string): boolean {
  target.setCustomValidity(message);
  target.setAttribute("aria-invalid", String(Boolean(message)));
  return !message;
}

function syncScalarInputIdentity(
  element: Element | undefined,
  controlIdentity: unknown,
  sourceIdentity: unknown,
  rowIdentity: unknown,
  pathKey: string,
  presentationIdentity: string,
  renderedValue: string,
  revalidate: (target: HTMLInputElement) => void,
): void {
  if (!(element instanceof HTMLInputElement)) {
    return;
  }
  const previous = scalarInputState.get(element);
  if (previous) {
    if (
      !Object.is(previous.sourceIdentity, sourceIdentity) ||
      !Object.is(previous.rowIdentity, rowIdentity) ||
      previous.pathKey !== pathKey ||
      previous.presentationIdentity !== presentationIdentity ||
      previous.renderedValue !== renderedValue
    ) {
      // A focused input whose DOM value drifted from the last render holds an
      // in-flight edit the model has not committed yet (mid-keystroke or
      // mid-automation fill). Resetting it here silently eats that input when
      // a background config refresh lands; blurred fields keep the
      // authoritative-reset contract.
      if (element.matches(":focus") && element.value !== previous.renderedValue) {
        revalidate(element);
      } else {
        element.value = renderedValue;
        setControlValidity(element, "");
      }
    } else if (!Object.is(previous.controlIdentity, controlIdentity)) {
      revalidate(element);
    }
  }
  scalarInputState.set(element, {
    controlIdentity,
    sourceIdentity,
    rowIdentity,
    pathKey,
    presentationIdentity,
    renderedValue,
  });
}

function coerceTextInputValue(
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

function stringConstraintMessage(
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

function shouldClearOptionalEmpty(
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

function numericConstraintMessage(value: number, schema: ConfigNodeRenderParams["schema"]): string {
  return isSupportedConfigValueValid(schema, value) ? "" : t("configForm.invalidNumber");
}

type NumericInputState =
  | { kind: "badInput" }
  | { kind: "empty" }
  | { kind: "invalid" }
  | { kind: "value"; parsed: number; message: string };

// Partial numeric text ("3.", "-", "1e") reports value === "" with
// validity.badInput set. Treating it as an intentional clear committed
// undefined mid-keystroke, wiping the stored value and the user's input.
function resolveNumericInputState(
  target: HTMLInputElement,
  schema: ConfigNodeRenderParams["schema"],
): NumericInputState {
  const raw = target.value;
  if (raw.trim() === "") {
    return target.validity.badInput ? { kind: "badInput" } : { kind: "empty" };
  }
  const parsed = coerceConfigFormNumberString(raw, schemaType(schema) === "integer");
  if (typeof parsed !== "number") {
    return { kind: "invalid" };
  }
  return { kind: "value", parsed, message: numericConstraintMessage(parsed, schema) };
}

function numericStateMessage(state: NumericInputState, isRequired: boolean): string {
  if (state.kind === "value") {
    return state.message;
  }
  if (state.kind === "invalid") {
    return t("configForm.invalidNumber");
  }
  return state.kind === "badInput" || isRequired ? t("configForm.invalidNumber") : "";
}

function applyNumericInputState(
  target: HTMLInputElement,
  state: NumericInputState,
  params: { isRequired?: boolean },
  commit: (candidate: unknown) => unknown,
): void {
  if (!setControlValidity(target, numericStateMessage(state, params.isRequired === true))) {
    return;
  }
  if (state.kind === "empty") {
    commit(undefined);
  } else if (state.kind === "value") {
    commit(state.parsed);
  }
}

function numericRevalidateMessage(
  target: HTMLInputElement,
  schema: ConfigNodeRenderParams["schema"],
  isRequired: boolean,
): string {
  return numericStateMessage(resolveNumericInputState(target, schema), isRequired);
}

export function renderTextInput(
  params: ConfigNodeRenderParams & { inputType: "text" | "number" },
): TemplateResult {
  const { schema, value, path, hints, disabled, onPatch, inputType } = params;
  const showLabel = params.showLabel ?? true;
  const hint = hintForPath(path, hints);
  const { label, help, tags } = resolveFieldMeta(path, schema, hints);
  const helpId = showLabel && help ? configFieldId(path, "description") : undefined;
  const sensitiveState = getSensitiveRenderState({
    path,
    value,
    hints,
    revealSensitive: params.revealSensitive ?? false,
    isSensitivePathRevealed: params.isSensitivePathRevealed,
  });
  const isStructuredValue =
    value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value);
  const isStructuredSecretRef = isSecretRefObject(value);
  const rawAvailable = params.rawAvailable ?? true;
  const effectiveRedacted = sensitiveState.isRedacted || isStructuredSecretRef;
  const placeholder = effectiveRedacted
    ? isStructuredSecretRef
      ? rawAvailable
        ? t("configForm.structuredSecretRaw")
        : t("configForm.structuredSecretFile")
      : redactedPlaceholder()
    : (hint?.placeholder ??
      (schema.default !== undefined
        ? t("configForm.defaultValue", { value: formatConfigValueText(schema.default) })
        : ""));
  const displayValue = effectiveRedacted
    ? ""
    : isStructuredValue
      ? jsonValue(value)
      : (value ?? "");
  const effectiveValue = value !== undefined ? value : schema.default;
  const initialBranch = scalarValueBranch(effectiveValue);
  const effectiveInputType = sensitiveState.isSensitive && !effectiveRedacted ? "text" : inputType;
  const isPhonePresentation = hint?.presentation === "phone-number";
  const phonePresentation =
    isPhonePresentation && !effectiveRedacted && typeof value === "string"
      ? formatInternationalPhoneNumberForDisplay(value, i18n.getLocale())
      : undefined;
  const controlIdentity = params.controlIdentity ?? params.sourceIdentity ?? value;
  const sourceIdentity = params.sourceIdentity ?? value;
  const controlPathKey = configFieldId(path, "scalar-identity");
  const renderedValue = formatConfigValueText(displayValue);
  const presentationIdentity = [
    effectiveRedacted ? "redacted" : "visible",
    effectiveInputType,
    isPhonePresentation ? "phone" : "plain",
    isStructuredSecretRef ? (rawAvailable ? "secret-raw" : "secret-file") : "scalar",
  ].join(":");
  const revalidate = (target: HTMLInputElement) => {
    if (effectiveRedacted) {
      setControlValidity(target, "");
      return;
    }
    if (inputType === "number") {
      setControlValidity(
        target,
        numericRevalidateMessage(target, schema, params.isRequired === true),
      );
      return;
    }
    const raw = target.value;
    const editHint = scalarEditHintForInput(target, initialBranch);
    const optionalEmpty = shouldClearOptionalEmpty(
      raw,
      schema,
      params.isRequired === true,
      effectiveValue,
      editHint,
    );
    setControlValidity(
      target,
      optionalEmpty ? "" : stringConstraintMessage(raw, schema, effectiveValue, editHint),
    );
  };
  const commitScalarValue = (target: HTMLInputElement, candidate: unknown) => {
    if (onPatch(path, candidate) !== false) {
      return true;
    }
    target.value = renderedValue;
    revalidate(target);
    return false;
  };

  const inputControl = html`
    <input
      ${ref((element) => {
        syncScalarEditIdentity(element, params.rowIdentity, controlPathKey, presentationIdentity);
        syncScalarInputIdentity(
          element,
          controlIdentity,
          sourceIdentity,
          params.rowIdentity,
          controlPathKey,
          presentationIdentity,
          renderedValue,
          revalidate,
        );
      })}
      type=${effectiveInputType}
      class="settings-input${effectiveRedacted ? " cfg-redacted" : ""}"
      aria-label=${label}
      aria-describedby=${helpId ?? nothing}
      aria-invalid="false"
      placeholder=${placeholder}
      .value=${renderedValue}
      ?disabled=${disabled}
      ?readonly=${effectiveRedacted}
      @click=${() => {
        if (sensitiveState.isRedacted && !isStructuredSecretRef && params.onToggleSensitivePath) {
          params.onToggleSensitivePath(path);
        }
      }}
      @input=${(event: Event) => {
        if (effectiveRedacted) {
          return;
        }
        const target = event.target as HTMLInputElement;
        const raw = target.value;
        if (inputType === "number") {
          applyNumericInputState(
            target,
            resolveNumericInputState(target, schema),
            params,
            (candidate) => commitScalarValue(target, candidate),
          );
          return;
        }
        const editHint = beginScalarEdit(target, initialBranch);
        if (
          shouldClearOptionalEmpty(
            raw,
            schema,
            params.isRequired === true,
            effectiveValue,
            editHint,
          )
        ) {
          setControlValidity(target, "");
          commitScalarValue(target, undefined);
        } else if (
          setControlValidity(target, stringConstraintMessage(raw, schema, effectiveValue, editHint))
        ) {
          commitScalarValue(target, coerceTextInputValue(raw, schema, effectiveValue, editHint));
        }
      }}
      @change=${(event: Event) => {
        if (inputType === "number" || effectiveRedacted) {
          return;
        }
        const target = event.target as HTMLInputElement;
        const editHint = beginScalarEdit(target, initialBranch);
        const raw = target.value;
        const rawMessage = stringConstraintMessage(raw, schema, effectiveValue, editHint);
        if (!rawMessage && !isPhonePresentation) {
          setControlValidity(target, "");
          commitScalarValue(target, coerceTextInputValue(raw, schema, effectiveValue, editHint));
          finishScalarEdit(target);
          return;
        }
        const normalized = raw.trim();
        if (
          shouldClearOptionalEmpty(
            normalized,
            schema,
            params.isRequired === true,
            effectiveValue,
            editHint,
          )
        ) {
          target.value = normalized;
          setControlValidity(target, "");
          commitScalarValue(target, undefined);
          finishScalarEdit(target);
          return;
        }
        const normalizedMessage = stringConstraintMessage(
          normalized,
          schema,
          effectiveValue,
          editHint,
        );
        if (normalizedMessage) {
          setControlValidity(target, rawMessage);
          finishScalarEdit(target);
          return;
        }
        target.value = normalized;
        setControlValidity(target, "");
        commitScalarValue(
          target,
          coerceTextInputValue(normalized, schema, effectiveValue, editHint),
        );
        finishScalarEdit(target);
      }}
      @blur=${finishScalarEditFromEvent}
    />
  `;
  const revealToggle = isStructuredSecretRef
    ? nothing
    : renderSensitiveToggleButton({
        path,
        state: sensitiveState,
        disabled,
        onToggleSensitivePath: params.onToggleSensitivePath,
      });
  const wrappedInput = wrapSensitiveControl(inputControl, revealToggle);
  const presentedInput = isPhonePresentation
    ? html`
        <span class="settings-phone-presentation">
          ${wrappedInput}
          ${phonePresentation
            ? html`<span class="settings-phone-presentation__value">${phonePresentation}</span>`
            : nothing}
        </span>
      `
    : wrappedInput;
  return renderFieldRow({
    label,
    help,
    helpId,
    defaultDescription: effectiveRedacted ? nothing : renderSchemaDefaultDescription(schema, value),
    tags,
    showLabel,
    control: presentedInput,
  });
}

export function renderNumberInput(params: ConfigNodeRenderParams): TemplateResult {
  const { schema, value, path, hints, disabled, onPatch } = params;
  const showLabel = params.showLabel ?? true;
  const { label, help, tags } = resolveFieldMeta(path, schema, hints);
  const helpId = showLabel && help ? configFieldId(path, "description") : undefined;
  const displayValue = value ?? "";
  const effectiveValue = value !== undefined ? value : schema.default;
  const constraints = numericInputConstraints(schema);
  const numericStep = typeof constraints.step === "number" ? constraints.step : 1;
  const controlIdentity = params.controlIdentity ?? params.sourceIdentity ?? value;
  const sourceIdentity = params.sourceIdentity ?? value;
  const controlPathKey = configFieldId(path, "scalar-identity");
  const renderedValue = formatConfigValueText(displayValue);
  const revalidate = (target: HTMLInputElement) => {
    setControlValidity(
      target,
      numericRevalidateMessage(target, schema, params.isRequired === true),
    );
  };
  const commitScalarValue = (target: HTMLInputElement, candidate: unknown) => {
    if (onPatch(path, candidate) !== false) {
      return true;
    }
    target.value = renderedValue;
    revalidate(target);
    return false;
  };

  // Touch devices and some browsers hide native number spinners; keep explicit
  // adjust buttons so schema-sized edits stay possible without typing.
  const step = (direction: -1 | 1) => {
    if (disabled) {
      return;
    }
    const current = Number(effectiveValue);
    const base = Number.isFinite(current) ? current : normalizeNumericValue(0, schema);
    const candidate = normalizeNumericValue(base + direction * numericStep, schema);
    if (isSupportedConfigValueValid(schema, candidate)) {
      onPatch(path, candidate);
    }
  };
  const control = html`
    <button
      type="button"
      class="btn btn--sm btn--icon"
      aria-label=${`${label}: -${numericStep}`}
      ?disabled=${disabled}
      @click=${() => step(-1)}
    >
      −
    </button>
    <input
      ${ref((element) =>
        syncScalarInputIdentity(
          element,
          controlIdentity,
          sourceIdentity,
          params.rowIdentity,
          controlPathKey,
          "number",
          renderedValue,
          revalidate,
        ),
      )}
      type="number"
      class="settings-input"
      aria-label=${label}
      aria-describedby=${helpId ?? nothing}
      aria-invalid="false"
      placeholder=${schema.default !== undefined
        ? t("configForm.defaultValue", { value: formatConfigValueText(schema.default) })
        : nothing}
      min=${constraints.min ?? nothing}
      max=${constraints.max ?? nothing}
      step=${constraints.step}
      .value=${renderedValue}
      ?disabled=${disabled}
      @keydown=${(event: KeyboardEvent) => {
        if (
          value === undefined &&
          effectiveValue !== undefined &&
          (event.key === "ArrowUp" || event.key === "ArrowDown")
        ) {
          event.preventDefault();
          step(event.key === "ArrowUp" ? 1 : -1);
        }
      }}
      @input=${(event: Event) => {
        const target = event.target as HTMLInputElement;
        applyNumericInputState(
          target,
          resolveNumericInputState(target, schema),
          params,
          (candidate) => commitScalarValue(target, candidate),
        );
      }}
      @change=${(event: Event) => {
        const target = event.target as HTMLInputElement;
        const state = resolveNumericInputState(target, schema);
        if (state.kind !== "value") {
          setControlValidity(target, numericStateMessage(state, params.isRequired === true));
          return;
        }
        const normalized = normalizeNumericValue(state.parsed, schema);
        target.value = formatConfigValueText(normalized);
        if (setControlValidity(target, numericConstraintMessage(normalized, schema))) {
          commitScalarValue(target, normalized);
        }
      }}
    />
    <button
      type="button"
      class="btn btn--sm btn--icon"
      aria-label=${`${label}: +${numericStep}`}
      ?disabled=${disabled}
      @click=${() => step(1)}
    >
      +
    </button>
  `;

  return renderFieldRow({
    label,
    help,
    helpId,
    defaultDescription: renderSchemaDefaultDescription(schema, value),
    tags,
    showLabel,
    control,
  });
}

export function renderSelect(
  params: ConfigNodeRenderParams & { options: unknown[] },
): TemplateResult {
  const { schema, value, path, hints, disabled, options, onPatch } = params;
  const showLabel = params.showLabel ?? true;
  const { label, help, tags } = resolveFieldMeta(path, schema, hints);
  const helpId = showLabel && help ? configFieldId(path, "description") : undefined;
  const usingDefault = value === undefined && schema.default !== undefined;
  const resolvedValue = usingDefault ? schema.default : value;
  const currentIndex = options.findIndex(
    (option) => option === resolvedValue || String(option) === String(resolvedValue),
  );
  const unset = "__unset__";
  const nullValue = "__null__";
  const canSelectNull = schema.nullable && schema.enumIncludesNull;
  const selectedValue = usingDefault
    ? unset
    : resolvedValue === null && canSelectNull
      ? nullValue
      : currentIndex >= 0
        ? String(currentIndex)
        : unset;

  const control = html`
    <select
      class="settings-select"
      aria-label=${label}
      aria-describedby=${helpId ?? nothing}
      ?disabled=${disabled}
      .value=${selectedValue}
      @change=${(event: Event) => {
        const target = event.target as HTMLSelectElement;
        const nextSelection = target.value;
        if (nextSelection === unset && params.isRequired && schema.default === undefined) {
          target.value = selectedValue;
          return;
        }
        if (nextSelection === unset) {
          const accepted =
            params.isRequired && schema.default !== undefined
              ? onPatch(path, structuredClone(schema.default))
              : params.onRemove
                ? params.onRemove(path)
                : onPatch(path, undefined);
          if (accepted === false) {
            target.value = selectedValue;
          }
          return;
        }
        const candidate = nextSelection === nullValue ? null : options[Number(nextSelection)];
        if (onPatch(path, candidate) === false) {
          target.value = selectedValue;
        }
      }}
    >
      <option
        value=${unset}
        ?selected=${selectedValue === unset}
        ?disabled=${params.isRequired && schema.default === undefined}
      >
        ${schema.default !== undefined
          ? t("configForm.defaultValue", { value: formatConfigValueText(schema.default) })
          : (hintForPath(path, hints)?.placeholder ?? t("configForm.select"))}
      </option>
      ${canSelectNull
        ? html`
            <option value=${nullValue} ?selected=${selectedValue === nullValue}>
              ${t("configForm.nullValue")}
            </option>
          `
        : nothing}
      ${options.map(
        (option, index) => html`
          <option value=${String(index)} ?selected=${selectedValue === String(index)}>
            ${configEnumOptionLabel(option, options)}
          </option>
        `,
      )}
    </select>
  `;

  return renderFieldRow({
    label,
    help,
    helpId,
    defaultDescription: renderSchemaDefaultDescription(schema, value),
    tags,
    showLabel,
    control,
  });
}
