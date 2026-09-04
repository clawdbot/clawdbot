import { html, nothing } from "lit";
import type { ApprovalPresentation } from "../../../../packages/gateway-protocol/src/approval-result-validators.js";
import { t } from "../../i18n/index.ts";

function renderMetaRow(label: string, value?: string | null) {
  return value
    ? html`<div class="approval-page__meta-row">
        <dt>${label}</dt>
        <dd title=${value}><bdi dir="ltr">${value}</bdi></dd>
      </div>`
    : nothing;
}

export function renderApprovalPresentation(presentation: ApprovalPresentation) {
  if (presentation.kind === "exec") {
    return html`
      ${
        presentation.warningText
          ? html`<div class="approval-page__warning" role="note">${presentation.warningText}</div>`
          : nothing
      }
      ${
        presentation.commandPreview
          ? html`
              <div class="approval-page__preview-label">${t("approvalPage.summaryLabel")}</div>
              <div class="approval-page__summary mono" dir="ltr">
                ${presentation.commandPreview}
              </div>
            `
          : nothing
      }
      <div class="approval-page__preview-label">${t("approvalPage.commandLabel")}</div>
      <pre class="approval-page__preview mono" dir="ltr">${presentation.commandText}</pre>
      <dl class="approval-page__meta">
        ${renderMetaRow(t("execApproval.labels.host"), presentation.host)}
        ${renderMetaRow(t("approvalPage.nodeLabel"), presentation.nodeId)}
      </dl>
    `;
  }
  const previewClass = "approval-page__preview approval-page__preview--prose";
  return html`
    <div class="approval-page__preview-label">${t("approvalPage.requestLabel")}</div>
    <div class=${previewClass}>${presentation.description}</div>
    ${
      presentation.kind === "plugin" && presentation.detail
        ? html`<pre class="approval-page__preview mono" dir="ltr">${presentation.detail}</pre>`
        : nothing
    }
  `;
}
