import { html, nothing } from "lit";
import type { ConfigUiHints } from "../types";
import { analyzeConfigSchema, renderConfigForm } from "./config-form";

export type ConfigProps = {
  raw: string;
  valid: boolean | null;
  issues: unknown[];
  loading: boolean;
  saving: boolean;
  connected: boolean;
  schema: unknown | null;
  schemaLoading: boolean;
  uiHints: ConfigUiHints;
  formMode: "form" | "raw";
  formValue: Record<string, unknown> | null;
  onRawChange: (next: string) => void;
  onFormModeChange: (mode: "form" | "raw") => void;
  onFormPatch: (path: Array<string | number>, value: unknown) => void;
  onReload: () => void;
  onSave: () => void;
};

export function renderConfig(props: ConfigProps) {
  const validity =
    props.valid == null ? "unknown" : props.valid ? "valid" : "invalid";
  const analysis = analyzeConfigSchema(props.schema);
  const formUnsafe = analysis.schema
    ? analysis.unsupportedPaths.length > 0
    : false;
  const canSaveForm =
    Boolean(props.formValue) && !props.loading && !formUnsafe;
  const canSave =
    props.connected &&
    !props.saving &&
    (props.formMode === "raw" ? true : canSaveForm);
  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div class="row">
          <div class="card-title">Config</div>
          <span class="pill">${validity}</span>
        </div>
        <div class="row">
          <div class="toggle-group">
            <button
              class="btn ${props.formMode === "form" ? "primary" : ""}"
              ?disabled=${props.schemaLoading || !props.schema}
              @click=${() => props.onFormModeChange("form")}
            >
              Form
            </button>
            <button
              class="btn ${props.formMode === "raw" ? "primary" : ""}"
              @click=${() => props.onFormModeChange("raw")}
            >
              Raw
            </button>
          </div>
          <button class="btn" ?disabled=${props.loading} @click=${props.onReload}>
            ${props.loading ? "Loading…" : "Reload"}
          </button>
          <button
            class="btn primary"
            ?disabled=${!canSave}
            @click=${props.onSave}
          >
            ${props.saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      <div class="muted" style="margin-top: 10px;">
        Writes to <span class="mono">~/.clawdbot/clawdbot.json</span>. Some changes
        require a gateway restart.
      </div>

      ${props.formMode === "form"
        ? html`<div style="margin-top: 12px;">
            ${props.schemaLoading
              ? html`<div class="muted">Loading schema…</div>`
              : renderConfigForm({
                  schema: analysis.schema,
                  uiHints: props.uiHints,
                  value: props.formValue,
                  disabled: props.loading || !props.formValue,
                  unsupportedPaths: analysis.unsupportedPaths,
                  onPatch: props.onFormPatch,
                })}
            ${formUnsafe
              ? html`<div class="callout danger" style="margin-top: 12px;">
                  Form view can’t safely edit some fields.
                  Use Raw to avoid losing config entries.
                </div>`
              : nothing}
          </div>`
        : html`<label class="field" style="margin-top: 12px;">
            <span>Raw JSON5</span>
            <textarea
              .value=${props.raw}
              @input=${(e: Event) =>
                props.onRawChange((e.target as HTMLTextAreaElement).value)}
            ></textarea>
          </label>`}

      ${props.issues.length > 0
        ? html`<div class="callout danger" style="margin-top: 12px;">
            <pre class="code-block">${JSON.stringify(props.issues, null, 2)}</pre>
          </div>`
        : nothing}
    </section>
  `;
}
