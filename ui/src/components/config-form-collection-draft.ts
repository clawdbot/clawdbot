import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { t } from "../i18n/index.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { configValuesEqual, isSupportedConfigValueValid } from "./config-form.constraints.ts";
import { schemaType, type JsonSchema } from "./config-form.shared.ts";

export type ConfigFormCollectionDraftProps = {
  schema: JsonSchema;
  label: string;
  disabled: boolean;
  identity: string;
  sourceIdentity: unknown;
  existingKeys?: readonly string[];
  existingValues?: readonly unknown[];
  validateValue?: (value: unknown) => boolean;
};

export type ConfigFormCollectionDraftCommit = {
  key?: string;
  value: unknown;
};

export class ConfigFormCollectionDraft extends OpenClawLightDomElement {
  @property({ attribute: false }) props?: ConfigFormCollectionDraftProps;

  @state() private draftOpen = false;
  @state() private draftKey = "";
  @state() private draftValue = "";
  @state() private draftIsNull = false;
  @state() private error = "";
  @state() private invalidTarget: "key" | "value" | null = null;

  protected override willUpdate(changedProperties: PropertyValues<this>): void {
    const previous = changedProperties.get("props") as ConfigFormCollectionDraftProps | undefined;
    const next = this.props;
    if (
      previous &&
      (!next ||
        previous.identity !== next.identity ||
        // Content equality, not Object.is: a drained autosave ack (or a
        // config.changed refresh) clones the whole form, changing every
        // identity while the bytes are unchanged — closing here would wipe
        // the operator's in-progress add-entry draft mid-typing.
        (!Object.is(previous.sourceIdentity, next.sourceIdentity) &&
          !configValuesEqual(previous.sourceIdentity, next.sourceIdentity)))
    ) {
      this.closeDraft();
    }
  }

  openDraft(): void {
    if (this.props?.disabled) {
      return;
    }
    this.draftOpen = true;
    void this.updateComplete.then(() => {
      this.querySelector<HTMLElement>("[data-collection-draft-value]")?.focus();
    });
  }

  private clearError(): void {
    this.error = "";
    this.invalidTarget = null;
  }

  private closeDraft(): void {
    this.draftOpen = false;
    this.draftKey = "";
    this.draftValue = "";
    this.draftIsNull = false;
    this.clearError();
  }

  private fail(target: "key" | "value", message: string): void {
    this.invalidTarget = target;
    this.error = message;
    void this.updateComplete.then(() => {
      this.querySelector<HTMLElement>(
        target === "key" ? "[data-collection-draft-key]" : "[data-collection-draft-value]",
      )?.focus();
    });
  }

  private parseValue(
    schema: JsonSchema,
  ): { ok: true; value: unknown } | { ok: false; message: string } {
    if (this.draftIsNull) {
      return { ok: true, value: null };
    }
    const valueType = schemaType(schema);
    if (valueType === "string") {
      return { ok: true, value: this.draftValue };
    }
    if (valueType === "number" || valueType === "integer") {
      const value = Number(this.draftValue);
      return this.draftValue.trim() && Number.isFinite(value)
        ? { ok: true, value }
        : { ok: false, message: t("configForm.invalidNumber") };
    }
    try {
      return { ok: true, value: JSON.parse(this.draftValue) };
    } catch {
      return { ok: false, message: t("configForm.invalidJson") };
    }
  }

  private commit(): void {
    const props = this.props;
    if (!props || props.disabled) {
      return;
    }
    const parsed = this.parseValue(props.schema);
    if (!parsed.ok) {
      this.fail("value", parsed.message);
      return;
    }
    if (!isSupportedConfigValueValid(props.schema, parsed.value)) {
      this.fail(
        "value",
        ["number", "integer"].includes(schemaType(props.schema) ?? "")
          ? t("configForm.invalidNumber")
          : t("configForm.invalidString"),
      );
      return;
    }
    if (props.existingValues?.some((value) => configValuesEqual(value, parsed.value))) {
      this.fail("value", t("configForm.invalidString"));
      return;
    }
    if (props.validateValue && !props.validateValue(parsed.value)) {
      this.fail("value", t("configForm.invalidString"));
      return;
    }
    const key = this.draftKey.trim();
    if (props.existingKeys && (!key || props.existingKeys.includes(key))) {
      this.fail("key", t("configForm.invalidString"));
      return;
    }

    const accepted = this.dispatchEvent(
      new CustomEvent<ConfigFormCollectionDraftCommit>("config-collection-draft-commit", {
        bubbles: true,
        composed: true,
        cancelable: true,
        detail: {
          ...(props.existingKeys ? { key } : {}),
          value: parsed.value,
        },
      }),
    );
    if (accepted) {
      this.closeDraft();
    } else {
      this.fail("value", t("configForm.invalidString"));
    }
  }

  protected override updated(): void {
    const keyInput = this.querySelector<HTMLInputElement>("[data-collection-draft-key]");
    const valueInput = this.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      "[data-collection-draft-value]",
    );
    keyInput?.setCustomValidity(this.invalidTarget === "key" ? this.error : "");
    valueInput?.setCustomValidity(this.invalidTarget === "value" ? this.error : "");
  }

  override render() {
    const props = this.props;
    if (!props || !this.draftOpen || props.disabled) {
      return nothing;
    }
    const valueType = schemaType(props.schema);
    const canUseNull = isSupportedConfigValueValid(props.schema, null);
    const usesTextInput =
      valueType === "string" || valueType === "number" || valueType === "integer";
    const errorId = `${this.id}-error`;
    const valueLabel = `${t("configForm.add")}: ${props.label}`;
    const valueControl = usesTextInput
      ? html`
          <input
            data-collection-draft-value
            type=${valueType === "string" ? "text" : "number"}
            class="settings-input"
            aria-label=${valueLabel}
            aria-describedby=${errorId}
            aria-invalid=${this.invalidTarget === "value" ? "true" : "false"}
            .value=${this.draftValue}
            ?disabled=${this.draftIsNull}
            @input=${(event: Event) => {
              this.draftValue = (event.currentTarget as HTMLInputElement).value;
              this.clearError();
            }}
          />
        `
      : html`
          <textarea
            data-collection-draft-value
            class="settings-input"
            aria-label=${valueLabel}
            aria-describedby=${errorId}
            aria-invalid=${this.invalidTarget === "value" ? "true" : "false"}
            placeholder=${t("configForm.jsonValue")}
            rows="2"
            .value=${this.draftValue}
            ?disabled=${this.draftIsNull}
            @input=${(event: Event) => {
              this.draftValue = (event.currentTarget as HTMLTextAreaElement).value;
              this.clearError();
            }}
          ></textarea>
        `;

    return html`
      <div class="settings-row settings-row--stacked cfg-collection-draft">
        <div class="settings-row__control">
          <div class="cfg-collection-draft__controls">
            ${props.existingKeys
              ? html`
                  <input
                    data-collection-draft-key
                    type="text"
                    class="settings-input"
                    aria-label=${t("configForm.key")}
                    aria-describedby=${errorId}
                    aria-invalid=${this.invalidTarget === "key" ? "true" : "false"}
                    placeholder=${t("configForm.key")}
                    .value=${this.draftKey}
                    @input=${(event: Event) => {
                      this.draftKey = (event.currentTarget as HTMLInputElement).value;
                      this.clearError();
                    }}
                  />
                `
              : nothing}
            ${canUseNull
              ? html`
                  <label class="field checkbox">
                    <input
                      data-collection-draft-null
                      type="checkbox"
                      .checked=${this.draftIsNull}
                      @change=${(event: Event) => {
                        this.draftIsNull = (event.currentTarget as HTMLInputElement).checked;
                        this.clearError();
                      }}
                    />
                    <span>${t("configForm.nullValue")}</span>
                  </label>
                `
              : nothing}
            ${valueControl}
            <span id=${errorId} class="cfg-field__error" role="alert" ?hidden=${!this.error}
              >${this.error}</span
            >
            <div class="cfg-collection-draft__actions">
              <button type="button" class="btn btn--sm" @click=${() => this.commit()}>
                ${props.existingKeys ? t("configForm.addEntry") : t("configForm.add")}
              </button>
              <button type="button" class="btn btn--sm" @click=${() => this.closeDraft()}>
                ${t("common.cancel")}
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }
}

if (!customElements.get("openclaw-config-form-collection-draft")) {
  customElements.define("openclaw-config-form-collection-draft", ConfigFormCollectionDraft);
}
