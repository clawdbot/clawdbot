// Control UI renderers for scalar config form nodes.
import { formatInternationalPhoneNumberForDisplay } from "@openclaw/normalization-core/phone-presentation";
import { html, nothing, type TemplateResult } from "lit";
import { i18n, t } from "../i18n/index.ts";
import { formatUnknownText } from "../lib/format.ts";
import {
  getSensitiveRenderState,
  isSecretRefObject,
  jsonValue,
  renderFieldRow,
  renderSensitiveToggleButton,
  wrapSensitiveControl,
  type ConfigNodeRenderParams,
} from "./config-form.node.shared.ts";
import { resolveConfigFieldMeta as resolveFieldMeta } from "./config-form.search.ts";
import { hintForPath, REDACTED_PLACEHOLDER } from "./config-form.shared.ts";

export function renderTextInput(
  params: ConfigNodeRenderParams & { inputType: "text" | "number" },
): TemplateResult {
  const { schema, value, path, hints, disabled, onPatch, inputType } = params;
  const showLabel = params.showLabel ?? true;
  const hint = hintForPath(path, hints);
  const { label, help, tags } = resolveFieldMeta(path, schema, hints);
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
      : REDACTED_PLACEHOLDER
    : (hint?.placeholder ??
      (schema.default !== undefined
        ? t("configForm.defaultValue", { value: formatUnknownText(schema.default) })
        : ""));
  const displayValue = effectiveRedacted
    ? ""
    : isStructuredValue
      ? jsonValue(value)
      : (value ?? "");
  const effectiveInputType = sensitiveState.isSensitive && !effectiveRedacted ? "text" : inputType;
  const isPhonePresentation = hint?.presentation === "phone-number";
  const phonePresentation =
    isPhonePresentation && !effectiveRedacted && typeof value === "string"
      ? formatInternationalPhoneNumberForDisplay(value, i18n.getLocale())
      : undefined;

  const inputControl = html`
    <input
      type=${effectiveInputType}
      class="settings-input${effectiveRedacted ? " cfg-redacted" : ""}"
      placeholder=${placeholder}
      .value=${formatUnknownText(displayValue)}
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
        const raw = (event.target as HTMLInputElement).value;
        if (inputType === "number") {
          if (raw.trim() === "") {
            onPatch(path, undefined);
            return;
          }
          const parsed = Number(raw);
          onPatch(path, Number.isNaN(parsed) ? raw : parsed);
          return;
        }
        onPatch(path, raw);
      }}
      @change=${(event: Event) => {
        if (inputType === "number" || effectiveRedacted) {
          return;
        }
        const raw = (event.target as HTMLInputElement).value;
        onPatch(path, raw.trim());
      }}
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
  const control = html`
    ${presentedInput}
    ${schema.default !== undefined
      ? html`
          <openclaw-tooltip .content=${t("configForm.resetToDefault")}>
            <button
              type="button"
              class="btn btn--icon"
              style="width:28px;height:28px;padding:0;"
              aria-label=${t("configForm.resetToDefault")}
              ?disabled=${disabled || effectiveRedacted}
              @click=${() => onPatch(path, schema.default)}
            >
              ↺
            </button>
          </openclaw-tooltip>
        `
      : nothing}
  `;

  return renderFieldRow({ label, help, tags, showLabel, control });
}

export function renderNumberInput(params: ConfigNodeRenderParams): TemplateResult {
  const { schema, value, path, hints, disabled, onPatch } = params;
  const showLabel = params.showLabel ?? true;
  const { label, help, tags } = resolveFieldMeta(path, schema, hints);
  const displayValue = value ?? schema.default ?? "";

  // Touch devices and some browsers hide native number spinners; keep explicit
  // one-step adjust buttons so single-step edits stay possible without typing.
  const step = (delta: number) => {
    if (disabled) {
      return;
    }
    const current = Number(displayValue);
    const base = Number.isFinite(current) ? current : 0;
    onPatch(path, base + delta);
  };
  const control = html`
    <button
      type="button"
      class="btn btn--sm btn--icon"
      aria-label=${`${label}: -1`}
      ?disabled=${disabled}
      @click=${() => step(-1)}
    >
      −
    </button>
    <input
      type="number"
      class="settings-input"
      aria-label=${label}
      .value=${formatUnknownText(displayValue)}
      ?disabled=${disabled}
      @input=${(event: Event) => {
        const raw = (event.target as HTMLInputElement).value;
        const parsed = raw === "" ? undefined : Number(raw);
        onPatch(path, parsed);
      }}
    />
    <button
      type="button"
      class="btn btn--sm btn--icon"
      aria-label=${`${label}: +1`}
      ?disabled=${disabled}
      @click=${() => step(1)}
    >
      +
    </button>
  `;

  return renderFieldRow({ label, help, tags, showLabel, control });
}

export function renderSelect(
  params: ConfigNodeRenderParams & { options: unknown[] },
): TemplateResult {
  const { schema, value, path, hints, disabled, options, onPatch } = params;
  const showLabel = params.showLabel ?? true;
  const { label, help, tags } = resolveFieldMeta(path, schema, hints);
  const resolvedValue = value ?? schema.default;
  const currentIndex = options.findIndex(
    (option) => option === resolvedValue || String(option) === String(resolvedValue),
  );
  const unset = "__unset__";

  const control = html`
    <select
      class="settings-select"
      ?disabled=${disabled}
      .value=${currentIndex >= 0 ? String(currentIndex) : unset}
      @change=${(event: Event) => {
        const selectedValue = (event.target as HTMLSelectElement).value;
        onPatch(path, selectedValue === unset ? undefined : options[Number(selectedValue)]);
      }}
    >
      <option value=${unset} ?selected=${currentIndex < 0}>${t("configForm.select")}</option>
      ${options.map(
        (option, index) => html`
          <option value=${String(index)} ?selected=${index === currentIndex}>
            ${String(option)}
          </option>
        `,
      )}
    </select>
  `;

  return renderFieldRow({ label, help, tags, showLabel, control });
}
