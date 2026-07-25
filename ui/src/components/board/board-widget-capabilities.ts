import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../i18n/index.ts";
import type { BoardGrantDecision, BoardViewWidget } from "../../lib/board/view-types.ts";

export function renderBoardPendingCapabilities(options: {
  widget: BoardViewWidget;
  disabled: boolean;
  onGrant: (decision: BoardGrantDecision) => void;
  error?: TemplateResult;
}): TemplateResult {
  const { widget } = options;
  const netOrigins = widget.declared?.netOrigins ?? [];
  const tools = widget.declared?.tools ?? [];
  return html`
    <div class="board-widget__grant board-widget__grant--pending" data-test-id="board-pending">
      <div class="board-widget__grant-mark" aria-hidden="true">!</div>
      <strong>${t("board.widget.needsApproval")}</strong>
      ${netOrigins.length > 0 || tools.length > 0
        ? html`<div class="board-widget__grant-groups">
            ${netOrigins.length > 0
              ? html`<section>
                  <strong>${t("board.widget.networkAccess")}</strong>
                  <ul class="board-widget__grant-summary">
                    ${netOrigins.map((origin) => html`<li>${origin}</li>`)}
                  </ul>
                </section>`
              : nothing}
            ${tools.length > 0
              ? html`<section>
                  <strong>${t("board.widget.hostTools")}</strong>
                  <ul class="board-widget__grant-summary">
                    ${tools.map((tool) => html`<li>${tool}</li>`)}
                  </ul>
                </section>`
              : nothing}
          </div>`
        : widget.declaredSummary?.length
          ? html`<ul class="board-widget__grant-summary">
              ${widget.declaredSummary.map((summary) => html`<li>${summary}</li>`)}
            </ul>`
          : html`<span>${t("board.widget.needsApprovalDetail")}</span>`}
      <div class="board-widget__grant-actions">
        <button
          class="btn btn--small btn--primary"
          type="button"
          data-test-id="board-grant-allow"
          ?disabled=${options.disabled}
          @click=${() => options.onGrant("granted")}
        >
          ${t("board.widget.allow")}
        </button>
        <button
          class="btn btn--small"
          type="button"
          data-test-id="board-grant-reject"
          ?disabled=${options.disabled}
          @click=${() => options.onGrant("rejected")}
        >
          ${t("board.widget.reject")}
        </button>
      </div>
      ${options.error ?? nothing}
    </div>
  `;
}

export function renderBoardGrantedCapabilities(
  widget: BoardViewWidget,
): TemplateResult | typeof nothing {
  if (widget.grantState !== "granted" || !widget.declared) {
    return nothing;
  }
  const capabilities = [
    ...(widget.declared.netOrigins ?? []).map((origin) =>
      t("board.widget.networkCapability", { capability: origin }),
    ),
    ...(widget.declared.tools ?? []).map((tool) =>
      t("board.widget.toolCapability", { capability: tool }),
    ),
  ];
  if (capabilities.length === 0) {
    return nothing;
  }
  return html`
    <openclaw-tooltip
      .content=${`${t("board.widget.activeCapabilities")}\n${capabilities.join("\n")}`}
    >
      <span class="board-widget__capabilities" data-test-id="board-capabilities-granted">
        ${t("board.widget.granted")}
      </span>
    </openclaw-tooltip>
  `;
}
