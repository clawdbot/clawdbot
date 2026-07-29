import { html, nothing } from "lit";
import type { ClawLifecyclePlanResult } from "../../../../packages/gateway-protocol/src/index.js";
import { icon } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import type { ClawSetupAnswers } from "./lifecycle-request.ts";

type ClawSetupInput = NonNullable<ClawLifecyclePlanResult["setup"]>["inputs"][number];

export type ClawSetupViewProps = {
  answers: ClawSetupAnswers;
  allowAnswerClearing?: boolean;
  disabledInputIds?: ReadonlySet<string>;
  operationBusy: boolean;
  onAnswerChange: (id: string, value: ClawSetupAnswers[string] | undefined) => void;
};

function answerValue(input: ClawSetupInput, answers: ClawSetupAnswers) {
  return Object.hasOwn(answers, input.id) ? answers[input.id] : input.default;
}

export function setupAnswerFromText(raw: string, type: "string" | "multiline" | "integer") {
  if (raw === "") {
    return undefined;
  }
  return type === "integer" ? Number(raw) : raw;
}

function renderSetupInput(input: ClawSetupInput, props: ClawSetupViewProps) {
  const value = answerValue(input, props.answers);
  const disabled = props.operationBusy || props.disabledInputIds?.has(input.id) === true;
  const description = input.description
    ? html`<span class="claws-setup__description">${input.description}</span>`
    : nothing;
  const wrap = (control: unknown) => html`<div class="claws-setup__answer">
    ${control}
    ${props.allowAnswerClearing && !input.required
      ? html`<button
          class="btn btn--icon claws-setup__clear"
          type="button"
          title=${t("clawsPage.setup.clear")}
          aria-label=${t("clawsPage.setup.clear")}
          ?disabled=${disabled}
          @click=${() => props.onAnswerChange(input.id, undefined)}
        >
          ${icon("x")}
        </button>`
      : nothing}
  </div>`;
  if (input.type === "boolean") {
    return wrap(html`<label class="claws-setup__boolean">
      <input
        type="checkbox"
        .checked=${value === true}
        ?disabled=${disabled}
        @change=${(event: Event) =>
          props.onAnswerChange(input.id, (event.currentTarget as HTMLInputElement).checked)}
      />
      <span><strong>${input.label}</strong>${description}</span>
    </label>`);
  }
  if (input.type === "choice") {
    return wrap(html`<label class="claws-setup__field">
      <span><strong>${input.label}</strong>${description}</span>
      <select
        .value=${typeof value === "string" ? value : ""}
        ?disabled=${disabled}
        @change=${(event: Event) => {
          const selected = (event.currentTarget as HTMLSelectElement).value;
          props.onAnswerChange(input.id, selected || undefined);
        }}
      >
        <option value="" disabled>${t("clawsPage.setup.select")}</option>
        ${input.options.map(
          (option) => html`<option value=${option.value}>${option.label}</option>`,
        )}
      </select>
    </label>`);
  }
  if (input.type === "multiChoice") {
    const selected = Array.isArray(value) ? value : [];
    return wrap(html`<fieldset class="claws-setup__choices">
      <legend><strong>${input.label}</strong>${description}</legend>
      ${input.options.map(
        (option) => html`<label>
          <input
            type="checkbox"
            .checked=${selected.includes(option.value)}
            ?disabled=${disabled}
            @change=${(event: Event) => {
              const checked = (event.currentTarget as HTMLInputElement).checked;
              props.onAnswerChange(
                input.id,
                checked
                  ? [...new Set([...selected, option.value])]
                  : selected.filter((entry) => entry !== option.value),
              );
            }}
          />${option.label}
        </label>`,
      )}
    </fieldset>`);
  }
  if (input.type === "multiline") {
    return wrap(html`<label class="claws-setup__field">
      <span><strong>${input.label}</strong>${description}</span>
      <textarea
        rows="4"
        maxlength=${input.maxLength}
        .value=${typeof value === "string" ? value : ""}
        ?disabled=${disabled}
        @input=${(event: Event) =>
          props.onAnswerChange(
            input.id,
            setupAnswerFromText((event.currentTarget as HTMLTextAreaElement).value, input.type),
          )}
      ></textarea>
    </label>`);
  }
  return wrap(html`<label class="claws-setup__field">
    <span><strong>${input.label}</strong>${description}</span>
    <input
      type=${input.type === "integer" ? "number" : "text"}
      .value=${value === undefined ? "" : String(value)}
      min=${input.type === "integer" && input.minimum !== undefined ? input.minimum : nothing}
      max=${input.type === "integer" && input.maximum !== undefined ? input.maximum : nothing}
      maxlength=${input.type === "string" ? input.maxLength : nothing}
      ?disabled=${disabled}
      @input=${(event: Event) => {
        const raw = (event.currentTarget as HTMLInputElement).value;
        props.onAnswerChange(input.id, setupAnswerFromText(raw, input.type));
      }}
    />
  </label>`);
}

export function renderClawSetupInputs(
  inputs: readonly ClawSetupInput[],
  props: ClawSetupViewProps,
) {
  return inputs.map((input) => renderSetupInput(input, props));
}
