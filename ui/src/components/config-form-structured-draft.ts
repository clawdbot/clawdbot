import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { t } from "../i18n/index.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { copyWithPathPatch } from "./config-form-copy-on-write.ts";
import { isSupportedConfigValueValid } from "./config-form.constraints.ts";
import type { ConfigNodeRenderer, ConfigNodeRenderParams } from "./config-form.node.shared.ts";
import { configFieldId, schemaType } from "./config-form.shared.ts";

export type ConfigFormStructuredDraftProps = {
  identity: string;
  sourceIdentity: unknown;
  initialValue: Record<string, unknown> | unknown[];
  params: ConfigNodeRenderParams;
  renderNode: ConfigNodeRenderer;
};

function cloneDraftValue(value: Record<string, unknown> | unknown[]) {
  return structuredClone(value);
}

export function structuredDraftInitialValue(
  params: ConfigNodeRenderParams,
): Record<string, unknown> | unknown[] | undefined {
  const type = schemaType(params.schema);
  if (type !== "object" && type !== "array") {
    return undefined;
  }
  const schemaDefault = params.schema.default;
  if (
    (type === "object" &&
      schemaDefault &&
      typeof schemaDefault === "object" &&
      !Array.isArray(schemaDefault)) ||
    (type === "array" && Array.isArray(schemaDefault))
  ) {
    return cloneDraftValue(schemaDefault as Record<string, unknown> | unknown[]);
  }
  return type === "object" ? {} : [];
}

export function shouldStageStructuredDraft(
  params: ConfigNodeRenderParams,
  initialValue: Record<string, unknown> | unknown[] | undefined,
): initialValue is Record<string, unknown> | unknown[] {
  return (
    initialValue !== undefined &&
    params.value === undefined &&
    params.isRequired !== true &&
    params.structuredDraftOwner !== true &&
    !isSupportedConfigValueValid(params.schema, initialValue)
  );
}

class ConfigFormStructuredDraft extends OpenClawLightDomElement {
  @property({ attribute: false }) props?: ConfigFormStructuredDraftProps;

  @state() private draftValue: Record<string, unknown> | unknown[] | undefined;
  @state() private error = "";

  protected override willUpdate(changedProperties: PropertyValues<this>): void {
    if (!changedProperties.has("props")) {
      return;
    }
    const previous = changedProperties.get("props") as ConfigFormStructuredDraftProps | undefined;
    const next = this.props;
    if (
      next &&
      (!previous ||
        previous.identity !== next.identity ||
        !Object.is(previous.sourceIdentity, next.sourceIdentity))
    ) {
      this.draftValue = cloneDraftValue(next.initialValue);
      this.error = "";
    }
  }

  private patchDraft(path: Array<string | number>, value: unknown): boolean {
    const props = this.props;
    const current = this.draftValue;
    if (!props || !current) {
      return false;
    }
    const rootPath = props.params.path;
    if (
      path.length < rootPath.length ||
      !rootPath.every((segment, index) => segment === path[index])
    ) {
      return false;
    }
    const relativePath = path.slice(rootPath.length);
    const patched =
      relativePath.length === 0
        ? { ok: true as const, value }
        : copyWithPathPatch(current, relativePath, value);
    if (!patched.ok) {
      return false;
    }
    const candidate = patched.value;
    const type = schemaType(props.params.schema);
    if (
      (type === "object" &&
        (!candidate || typeof candidate !== "object" || Array.isArray(candidate))) ||
      (type === "array" && !Array.isArray(candidate))
    ) {
      return false;
    }

    this.draftValue = candidate as Record<string, unknown> | unknown[];
    this.error = "";
    if (!isSupportedConfigValueValid(props.params.schema, candidate)) {
      return true;
    }
    if (props.params.onPatch(rootPath, candidate) !== false) {
      return true;
    }
    this.error = t("configForm.draftRejected");
    return false;
  }

  override render() {
    const props = this.props;
    const draftValue = this.draftValue;
    if (!props || !draftValue) {
      return nothing;
    }
    const errorId = configFieldId(props.params.path, "structured-draft-error");
    return html`
      ${props.renderNode({
        ...props.params,
        value: draftValue,
        sourceIdentity: draftValue,
        controlIdentity: draftValue,
        structuredDraftOwner: true,
        onPatch: (path, value) => this.patchDraft(path, value),
        onRemove: (path) => this.patchDraft(path, undefined),
      })}
      ${this.error
        ? html`
            <div class="settings-row settings-row--stacked cfg-structured-draft__error">
              <div class="settings-row__control">
                <span id=${errorId} class="cfg-field__error" role="alert">${this.error}</span>
              </div>
            </div>
          `
        : nothing}
    `;
  }
}

if (!customElements.get("openclaw-config-form-structured-draft")) {
  customElements.define("openclaw-config-form-structured-draft", ConfigFormStructuredDraft);
}
