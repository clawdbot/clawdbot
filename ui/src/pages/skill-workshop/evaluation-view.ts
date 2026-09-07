import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import type {
  SkillWorkshopEvaluation,
  SkillWorkshopEvaluationFinding,
  SkillWorkshopEvaluationOutcome,
} from "../../lib/skill-workshop/index.ts";

export function renderSkillWorkshopEvaluation(evaluation: SkillWorkshopEvaluation) {
  const completedAt = Date.parse(evaluation.completedAt);
  return html`
    <section class="sw-evaluation">
      <header class="sw-evaluation__head">
        <h3>${t("skillWorkshop.evaluation.title")}</h3>
        <div class="sw-evaluation__meta">
          <span>
            ${t("skillWorkshop.evaluation.version", {
              version: evaluation.proposedVersion,
            })}
          </span>
          ${
            Number.isFinite(completedAt)
              ? html`<span>
                  ${t("skillWorkshop.evaluation.completedAt", {
                    time: formatRelativeTimestamp(completedAt, { dateFallback: true }),
                  })}
                </span>`
              : nothing
          }
        </div>
      </header>
      <div class="sw-evaluation__outcomes">
        ${evaluation.outcomes.map((outcome) => renderEvaluationOutcome(outcome))}
      </div>
    </section>
  `;
}

function renderEvaluationOutcome(outcome: SkillWorkshopEvaluationOutcome) {
  const result = outcome.result;
  const pluginLabel = outcome.pluginVersion
    ? `${outcome.pluginId} ${outcome.pluginVersion}`
    : outcome.pluginId;
  return html`
    <section class="sw-evaluation__outcome">
      <div class="sw-evaluation__outcome-head">
        <div class="sw-evaluation__identity">
          <strong>${outcome.evaluatorId}</strong>
          <span>${pluginLabel}</span>
        </div>
        <div class="sw-evaluation__badges">
          <span class="sw-evaluation__badge is-${outcome.status}">
            ${t(`skillWorkshop.evaluation.status.${outcome.status}`)}
          </span>
          ${
            result?.decision
              ? html`<span class="sw-evaluation__badge is-${result.decision}">
                  ${t(`skillWorkshop.evaluation.decision.${result.decision}`)}
                </span>`
              : nothing
          }
        </div>
      </div>
      ${result?.summary ? html`<p class="sw-evaluation__summary">${result.summary}</p>` : nothing}
      ${
        result?.decisionReason
          ? html`<p class="sw-evaluation__reason">
              ${formatUiExternalText(result.decisionReason)}
            </p>`
          : nothing
      }
      ${
        outcome.error
          ? html`<p class="sw-evaluation__error">${formatUiExternalText(outcome.error)}</p>`
          : nothing
      }
      ${result?.findings?.length ? renderEvaluationFindings(result.findings) : nothing}
      ${
        result?.metrics && Object.keys(result.metrics).length > 0
          ? renderEvaluationMetrics(result.metrics)
          : nothing
      }
      ${
        result?.evaluatorVersion || result?.mode
          ? html`
              <div class="sw-evaluation__runtime">
                ${
                  result.evaluatorVersion
                    ? html`<span>
                        ${t("skillWorkshop.evaluation.evaluatorVersion", {
                          version: result.evaluatorVersion,
                        })}
                      </span>`
                    : nothing
                }
                ${
                  result.mode
                    ? html`<span>
                        ${t("skillWorkshop.evaluation.mode", { mode: result.mode })}
                      </span>`
                    : nothing
                }
              </div>
            `
          : nothing
      }
    </section>
  `;
}

function renderEvaluationFindings(findings: SkillWorkshopEvaluationFinding[]) {
  return html`
    <div class="sw-evaluation__findings">
      <h4>${t("skillWorkshop.evaluation.findings")}</h4>
      <ul>
        ${findings.map((finding) => {
          const location = finding.file
            ? finding.line
              ? t("skillWorkshop.evaluation.fileLine", {
                  file: finding.file,
                  line: String(finding.line),
                })
              : finding.file
            : null;
          return html`
            <li>
              <span class="sw-evaluation__severity is-${finding.severity}">
                ${t(`skillWorkshop.evaluation.severity.${finding.severity}`)}
              </span>
              <span>
                <code class="sw-evaluation__rule">${finding.ruleId}</code>
                ${formatUiExternalText(finding.message)}
                ${location ? html`<small>${location}</small>` : nothing}
              </span>
            </li>
          `;
        })}
      </ul>
    </div>
  `;
}

function renderEvaluationMetrics(metrics: Record<string, string | number | boolean>) {
  return html`
    <div class="sw-evaluation__metrics">
      <h4>${t("skillWorkshop.evaluation.metrics")}</h4>
      <dl>
        ${Object.entries(metrics)
          .toSorted(([left], [right]) => left.localeCompare(right))
          .map(
            ([name, value]) => html`
              <div>
                <dt>${name}</dt>
                <dd>${String(value)}</dd>
              </div>
            `,
          )}
      </dl>
    </div>
  `;
}
