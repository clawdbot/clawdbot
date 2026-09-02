// Control UI renders the agent file save error and its conflict resolution.
import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";

export function renderAgentFileError(params: {
  error: string | null;
  conflictName: string | null;
  busy: boolean;
  canWrite: boolean;
  onReload: (name: string) => void;
  onOverwrite: (name: string) => void;
}) {
  const conflictName = params.conflictName;
  if (!conflictName) {
    return params.error ? html`<div class="callout danger">${params.error}</div>` : nothing;
  }
  return html`<div class="callout danger">
    <span>${params.error ?? t("agents.files.conflictHint")}</span>
    <div class="agent-file-actions">
      <button
        class="btn btn--sm"
        type="button"
        ?disabled=${params.busy}
        @click=${() => params.onReload(conflictName)}
      >
        ${t("common.reload")}
      </button>
      <button
        class="btn btn--sm"
        type="button"
        ?disabled=${params.busy || !params.canWrite}
        @click=${() => params.onOverwrite(conflictName)}
      >
        ${t("agents.files.overwrite")}
      </button>
    </div>
  </div>`;
}
