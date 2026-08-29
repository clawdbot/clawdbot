import { html, nothing, type TemplateResult } from "lit";
import type {
  AuditRunInspectResult,
  DecisionReceiptDisplayV1,
} from "../../../../packages/gateway-protocol/src/schema/audit-run.js";
import { t } from "../../i18n/index.ts";
import {
  activityRunInspectorSelectorHref,
  type RunInspectorSelector,
  type RunInspectorState,
} from "./run-inspector-model.ts";

type ReceiptSectionOptions = { headingId?: string; headingLevel?: 3 | 6 };

export function runInspectorCoverageKey(
  state: AuditRunInspectResult["coverage"]["state"],
): "enforced" | "attributionOnly" | "unattributed" | "unknown" | "unsupported" {
  return state === "attribution-only" ? "attributionOnly" : state;
}

export function runInspectorCoverageLabel(
  state: AuditRunInspectResult["coverage"]["state"],
): string {
  return t(`activity.runInspector.coverage.${runInspectorCoverageKey(state)}.label`);
}

export function renderRunInspectorSafeRef(value: string | number, mono = false, href?: string) {
  const content = html`<bdi
    class=${mono ? "run-inspector__ref mono" : "run-inspector__ref"}
    dir="ltr"
    >${value}</bdi
  >`;
  return href ? html`<a href=${href}>${content}</a>` : content;
}

function renderSectionHeading(label: string, headingId: string, headingLevel: 3 | 6) {
  return headingLevel === 6
    ? html`<h6 id=${headingId}>${label}</h6>`
    : html`<h3 id=${headingId}>${label}</h3>`;
}

export function renderRunInspectorMissingEvidence(
  values: readonly string[],
  options: ReceiptSectionOptions = {},
) {
  const headingId = options.headingId ?? "run-inspector-missing-heading";
  return html`
    <section class="run-inspector__section" aria-labelledby=${headingId}>
      ${renderSectionHeading(
        t("activity.runInspector.missingEvidenceHeading"),
        headingId,
        options.headingLevel ?? 3,
      )}
      ${values.length === 0
        ? html`<p>${t("activity.runInspector.noMissingEvidence")}</p>`
        : html`<ul class="run-inspector__code-list">
            ${values.map((value) => html`<li>${renderRunInspectorSafeRef(value, true)}</li>`)}
          </ul>`}
    </section>
  `;
}

export function renderRunInspectorRemediation(
  remediation: readonly { code: string; text: string }[],
  options: ReceiptSectionOptions = {},
): TemplateResult | typeof nothing {
  if (remediation.length === 0) {
    return nothing;
  }
  const headingId = options.headingId ?? "run-inspector-remediation-heading";
  return html`
    <section class="run-inspector__section" aria-labelledby=${headingId}>
      ${renderSectionHeading(
        t("activity.runInspector.nextStepsHeading"),
        headingId,
        options.headingLevel ?? 3,
      )}
      <ul class="run-inspector__remediation-list">
        ${remediation.map(
          (item) => html`<li>
            <span>${item.text}</span> ${renderRunInspectorSafeRef(item.code, true)}
          </li>`,
        )}
      </ul>
    </section>
  `;
}

function receiptInspectorHref(
  selector: RunInspectorSelector,
  selectorId: string,
  decisionCursor: string | undefined,
  basePath: string,
): string {
  return activityRunInspectorSelectorHref(selector, basePath, {
    id: selectorId,
    decisionCursor,
  });
}

function decisionOutcomeLabel(outcome: DecisionReceiptDisplayV1["decision"]["outcome"]): string {
  return t(
    `activity.runInspector.decisions.outcomes.${outcome === "not-applicable" ? "notApplicable" : outcome}`,
  );
}

function renderReceiptCodes(values: readonly string[], emptyCopy: string) {
  return values.length === 0
    ? html`<p class="run-inspector__reason">${emptyCopy}</p>`
    : html`<ul class="run-inspector__code-list">
        ${values.map((value) => html`<li>${renderRunInspectorSafeRef(value, true)}</li>`)}
      </ul>`;
}

function renderReceiptDetail(receipt: DecisionReceiptDisplayV1) {
  const coverage = receipt.enforcement.coverageState;
  return html`
    <article class="run-inspector__receipt-detail" aria-labelledby="run-inspector-receipt-detail">
      <h4 id="run-inspector-receipt-detail">
        ${t("activity.runInspector.decisions.detailHeading")}
      </h4>
      <section aria-labelledby="run-inspector-receipt-requested">
        <h5 id="run-inspector-receipt-requested">
          ${t("activity.runInspector.decisions.requestedHeading")}
        </h5>
        ${receipt.action.summary ? html`<p>${receipt.action.summary}</p>` : nothing}
        <dl class="run-inspector__values">
          <div>
            <dt>${t("activity.runInspector.values.kind")}</dt>
            <dd>${renderRunInspectorSafeRef(receipt.action.family)}</dd>
          </div>
          <div>
            <dt>${t("activity.runInspector.values.operation")}</dt>
            <dd>${renderRunInspectorSafeRef(receipt.action.operation)}</dd>
          </div>
        </dl>
      </section>
      <section aria-labelledby="run-inspector-receipt-outcome">
        <h5 id="run-inspector-receipt-outcome">
          ${t("activity.runInspector.decisions.outcomeHeading")}
        </h5>
        <div class="run-inspector__receipt-badges">
          <span
            class="run-inspector__receipt-badge run-inspector__receipt-badge--${receipt.decision
              .outcome}"
            aria-label=${`${t("activity.runInspector.decisions.outcomeLabel")}: ${decisionOutcomeLabel(
              receipt.decision.outcome,
            )}`}
          >
            ${decisionOutcomeLabel(receipt.decision.outcome)}
          </span>
          <span
            class="run-inspector__receipt-badge run-inspector__receipt-badge--${coverage}"
            aria-label=${`${t("activity.runInspector.decisions.classificationLabel")}: ${runInspectorCoverageLabel(
              coverage,
            )}`}
          >
            ${runInspectorCoverageLabel(coverage)}
          </span>
        </div>
        <p class="run-inspector__reason">
          ${t(`activity.runInspector.coverage.${runInspectorCoverageKey(coverage)}.description`)}
        </p>
        <dl class="run-inspector__values">
          <div>
            <dt>${t("activity.runInspector.decisions.reasonLabel")}</dt>
            <dd>${renderRunInspectorSafeRef(receipt.decision.reasonCode, true)}</dd>
          </div>
          <div>
            <dt>${t("activity.runInspector.decisions.occurredAtLabel")}</dt>
            <dd>${new Date(receipt.occurredAt).toLocaleString()}</dd>
          </div>
        </dl>
      </section>
      <section aria-labelledby="run-inspector-receipt-owner">
        <h5 id="run-inspector-receipt-owner">
          ${t("activity.runInspector.decisions.ownerHeading")}
        </h5>
        ${receipt.provenance.state === "verified"
          ? html`<dl class="run-inspector__values">
                <div>
                  <dt>${t("activity.runInspector.decisions.durableOwnerLabel")}</dt>
                  <dd>${renderRunInspectorSafeRef(receipt.provenance.producer)}</dd>
                </div>
              </dl>
              <p class="run-inspector__reason">
                ${t("activity.runInspector.decisions.ownerNote")}
              </p>`
          : html`<p class="run-inspector__reason">
              ${t("activity.runInspector.decisions.ownerNote")}
            </p>`}
      </section>
      <section aria-labelledby="run-inspector-receipt-evidence">
        <h5 id="run-inspector-receipt-evidence">
          ${t("activity.runInspector.decisions.evidenceHeading")}
        </h5>
        <dl class="run-inspector__values">
          <div>
            <dt>${t("activity.runInspector.decisions.policyCountLabel")}</dt>
            <dd>${receipt.enforcement.policyCount}</dd>
          </div>
          <div>
            <dt>${t("activity.runInspector.decisions.grantCountLabel")}</dt>
            <dd>${receipt.enforcement.grantCount}</dd>
          </div>
        </dl>
        <h6>${t("activity.runInspector.decisions.contextFieldsLabel")}</h6>
        ${renderReceiptCodes(
          receipt.enforcement.contextFieldsUsed,
          t("activity.runInspector.decisions.noContextFields"),
        )}
        ${renderRunInspectorMissingEvidence(receipt.missingEvidence, {
          headingId: "run-inspector-receipt-missing-heading",
          headingLevel: 6,
        })}
      </section>
      ${renderRunInspectorRemediation(receipt.remediation, {
        headingId: "run-inspector-receipt-remediation-heading",
        headingLevel: 6,
      })}
    </article>
  `;
}

export function renderRunInspectorDecisions(
  state: Extract<RunInspectorState, { status: "ready" }>,
  selector: RunInspectorSelector | null,
  selectorId: string | null,
  basePath: string,
  onLoadMoreDecisions: () => void,
) {
  const result = state.result;
  const selectedReceipt = selectorId
    ? result.decisionDisplays.find((receipt) => receipt.selectorId === selectorId)
    : result.decisionDisplays[0];
  return html`
    <section class="run-inspector__section" aria-labelledby="run-inspector-decisions-heading">
      <h3 id="run-inspector-decisions-heading">${t("activity.runInspector.decisions.heading")}</h3>
      ${result.decisionDisplays.length === 0
        ? html`<p>${t("activity.runInspector.decisions.none")}</p>`
        : html`<p>
            ${t("activity.runInspector.decisions.returned", {
              count: String(result.decisionDisplays.length),
            })}
          </p>`}
      <div class="run-inspector__warning" role="note">
        ${t("activity.runInspector.decisions.readOnly")}
      </div>
      ${result.decisionDisplays.length > 0 && selector
        ? html`<ol
            class="run-inspector__receipt-list"
            aria-label=${t("activity.runInspector.decisions.listLabel")}
          >
            ${result.decisionDisplays.map((receipt) => {
              const selected = selectedReceipt?.selectorId === receipt.selectorId;
              return html`<li>
                <a
                  href=${receiptInspectorHref(
                    selector,
                    receipt.selectorId,
                    state.receiptPageCursors.get(receipt.selectorId),
                    basePath,
                  )}
                  aria-current=${selected ? "true" : nothing}
                  aria-label=${t("activity.runInspector.decisions.inspectLabel", {
                    summary:
                      receipt.action.summary ??
                      `${receipt.action.family} · ${receipt.action.operation}`,
                    outcome: decisionOutcomeLabel(receipt.decision.outcome),
                    classification: runInspectorCoverageLabel(receipt.enforcement.coverageState),
                  })}
                >
                  <span
                    >${receipt.action.summary ??
                    `${receipt.action.family} · ${receipt.action.operation}`}</span
                  >
                  <span class="run-inspector__receipt-badges" aria-hidden="true">
                    <span
                      class="run-inspector__receipt-badge run-inspector__receipt-badge--${receipt
                        .decision.outcome}"
                      >${decisionOutcomeLabel(receipt.decision.outcome)}</span
                    >
                    <span
                      class="run-inspector__receipt-badge run-inspector__receipt-badge--${receipt
                        .enforcement.coverageState}"
                      >${runInspectorCoverageLabel(receipt.enforcement.coverageState)}</span
                    >
                  </span>
                </a>
              </li>`;
            })}
          </ol>`
        : nothing}
      ${result.nextDecisionCursor
        ? html`<div class="run-inspector__pagination">
            <span>${t("activity.runInspector.decisions.more")}</span>
            <button
              type="button"
              class="btn"
              ?disabled=${state.decisionPageStatus === "loading"}
              @click=${onLoadMoreDecisions}
            >
              ${state.decisionPageStatus === "loading"
                ? t("activity.runInspector.decisions.loadingMore")
                : t("activity.runInspector.decisions.loadMore")}
            </button>
            ${state.decisionPageStatus === "error"
              ? html`<span role="alert">
                  ${t("activity.runInspector.decisions.loadMoreError")}
                </span>`
              : nothing}
          </div>`
        : html`<div class="run-inspector__pagination" role="note">
            ${t("activity.runInspector.decisions.bounded")}
          </div>`}
      ${selectorId && !selectedReceipt
        ? html`<div class="run-inspector__result-state" role="status">
            <h4>${t("activity.runInspector.decisions.notFoundTitle")}</h4>
            <p>${t("activity.runInspector.decisions.notFoundDescription")}</p>
            ${selector
              ? html`<a href=${activityRunInspectorSelectorHref(selector, basePath)}>
                  ${t("activity.runInspector.decisions.heading")}
                </a>`
              : nothing}
          </div>`
        : selectedReceipt
          ? renderReceiptDetail(selectedReceipt)
          : nothing}
    </section>
  `;
}
