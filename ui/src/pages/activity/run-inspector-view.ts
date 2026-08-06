import { html, nothing, type TemplateResult } from "lit";
import type {
  AuditRunInspectResult,
  ExecutionIdentityContextV1,
  PrincipalRefV1,
} from "../../../../packages/gateway-protocol/src/schema/audit-run.js";
import { pathForRoute } from "../../app-route-paths.ts";
import { t } from "../../i18n/index.ts";
import { classifyRunInspection, type RunInspectorState } from "./run-inspector-model.ts";
import "./run-inspector.css";

type EvidenceState = "present" | "absent" | "unknown" | "unsupported";

type RunInspectorProps = {
  basePath: string;
  state: RunInspectorState;
  onRetry: () => void;
};

type FactValue = {
  label: string;
  value: string | number;
  mono?: boolean;
  href?: string;
};

type IdentityFact = {
  label: string;
  state: EvidenceState;
  values?: FactValue[];
  reason?: string;
};

function evidenceStateLabel(state: EvidenceState): string {
  return t(`activity.runInspector.evidenceState.${state}`);
}

function coverageKey(
  state: AuditRunInspectResult["coverage"]["state"],
): "enforced" | "attributionOnly" | "unattributed" | "unknown" | "unsupported" {
  return state === "attribution-only" ? "attributionOnly" : state;
}

function coverageLabel(state: AuditRunInspectResult["coverage"]["state"]): string {
  return t(`activity.runInspector.coverage.${coverageKey(state)}.label`);
}

function renderSafeRef(value: string | number, mono = false, href?: string) {
  const content = html`<bdi
    class=${mono ? "run-inspector__ref mono" : "run-inspector__ref"}
    dir="ltr"
    >${value}</bdi
  >`;
  return href ? html`<a href=${href}>${content}</a>` : content;
}

function stateReason(label: string, state: EvidenceState): string | undefined {
  switch (state) {
    case "absent":
      return t("activity.runInspector.reasons.absent", { label: label.toLowerCase() });
    case "unknown":
      return t("activity.runInspector.reasons.unknown", { label: label.toLowerCase() });
    case "unsupported":
      return t("activity.runInspector.reasons.unsupported", { label: label.toLowerCase() });
    case "present":
      return undefined;
  }
  const unreachable: never = state;
  return unreachable;
}

function principalValues(principal: PrincipalRefV1 | undefined): FactValue[] {
  if (!principal) {
    return [];
  }
  return [
    ...(principal.displayLabel
      ? [{ label: t("activity.runInspector.values.label"), value: principal.displayLabel }]
      : []),
    { label: t("activity.runInspector.values.kind"), value: principal.kind },
    {
      label: t("activity.runInspector.values.principalReference"),
      value: principal.principalRef,
      mono: true,
    },
    {
      label: t("activity.runInspector.values.domainReference"),
      value: principal.domainRef,
      mono: true,
    },
  ];
}

function renderFact(fact: IdentityFact) {
  const values = fact.values ?? [];
  const reason = fact.reason ?? stateReason(fact.label, fact.state);
  return html`
    <div class="run-inspector__fact" data-state=${fact.state}>
      <dt>
        <span>${fact.label}</span>
        <span
          class="run-inspector__state run-inspector__state--${fact.state}"
          aria-label=${t("activity.runInspector.evidenceStateLabel", {
            state: evidenceStateLabel(fact.state),
          })}
        >
          ${evidenceStateLabel(fact.state)}
        </span>
      </dt>
      <dd>
        ${values.length > 0
          ? html`<dl class="run-inspector__values">
              ${values.map(
                (item) => html`
                  <div>
                    <dt>${item.label}</dt>
                    <dd>${renderSafeRef(item.value, item.mono, item.href)}</dd>
                  </div>
                `,
              )}
            </dl>`
          : nothing}
        ${reason ? html`<p class="run-inspector__reason">${reason}</p>` : nothing}
      </dd>
    </div>
  `;
}

function runInspectorHref(runId: string, basePath: string): string {
  const search = new URLSearchParams({ view: "run", run: runId });
  return `${pathForRoute("activity", basePath)}?${search.toString()}`;
}

function executionInspectorHref(executionId: string, basePath: string): string {
  const search = new URLSearchParams({ view: "run", execution: executionId });
  return `${pathForRoute("activity", basePath)}?${search.toString()}`;
}

function identityFacts(context: ExecutionIdentityContextV1, basePath: string): IdentityFact[] {
  const representedSubject = context.representedSubject;
  const sponsor = context.sponsor;
  const lineage = context.lineage;
  return [
    {
      label: t("activity.runInspector.facts.trustDomain"),
      state: context.trustDomain.state,
      values: [
        { label: t("activity.runInspector.values.kind"), value: context.trustDomain.kind },
        {
          label: t("activity.runInspector.values.domainReference"),
          value: context.trustDomain.domainRef,
          mono: true,
        },
      ],
    },
    {
      label: t("activity.runInspector.facts.ingress"),
      state: context.ingress.state,
      values: [
        { label: t("activity.runInspector.values.kind"), value: context.ingress.kind },
        {
          label: t("activity.runInspector.values.owningBoundary"),
          value: context.ingress.boundary,
          mono: true,
        },
        ...(context.ingress.sourceRef
          ? [
              {
                label: t("activity.runInspector.values.sourceReference"),
                value: context.ingress.sourceRef,
                mono: true,
              },
            ]
          : []),
      ],
    },
    {
      label: t("activity.runInspector.facts.invoker"),
      state: context.invoker.state,
      values: principalValues(context.invoker.principal),
      reason:
        context.invoker.state === "absent"
          ? t("activity.runInspector.reasons.invokerAbsent")
          : undefined,
    },
    {
      label: t("activity.runInspector.facts.representedSubject"),
      state: representedSubject?.state ?? "absent",
      values: principalValues(representedSubject?.principal),
    },
    {
      label: t("activity.runInspector.facts.sponsor"),
      state: sponsor?.state ?? "absent",
      values: [
        ...principalValues(sponsor?.principal),
        ...(sponsor?.relationshipRef
          ? [
              {
                label: t("activity.runInspector.values.relationshipReference"),
                value: sponsor.relationshipRef,
                mono: true,
              },
            ]
          : []),
      ],
    },
    {
      label: t("activity.runInspector.facts.agentDefinition"),
      state: context.agentDefinition.state,
      values: [
        {
          label: t("activity.runInspector.values.definitionReference"),
          value: context.agentDefinition.definitionRef,
          mono: true,
        },
        ...(context.agentDefinition.revisionRef
          ? [
              {
                label: t("activity.runInspector.values.revisionReference"),
                value: context.agentDefinition.revisionRef,
                mono: true,
              },
            ]
          : []),
      ],
    },
    {
      label: t("activity.runInspector.facts.agentPrincipal"),
      state: "present",
      values: principalValues(context.agentPrincipal),
    },
    {
      label: t("activity.runInspector.facts.runtimeInstance"),
      state: context.runtimeInstance.state,
      values: [
        { label: t("activity.runInspector.values.kind"), value: context.runtimeInstance.kind },
        {
          label: t("activity.runInspector.values.runtimeReference"),
          value: context.runtimeInstance.runtimeRef,
          mono: true,
        },
      ],
    },
    ...(context.applicableGrants.length === 0
      ? [
          {
            label: t("activity.runInspector.facts.applicableGrants"),
            state: "absent" as const,
            reason: t("activity.runInspector.reasons.noGrants"),
          },
        ]
      : context.applicableGrants.map((grant, index) => ({
          label: t("activity.runInspector.facts.applicableGrant", { index: String(index + 1) }),
          state: grant.state,
          values: [
            {
              label: t("activity.runInspector.values.grantReference"),
              value: grant.grantRef,
              mono: true,
            },
          ],
        }))),
    ...(context.assurance.length === 0
      ? [
          {
            label: t("activity.runInspector.facts.assuranceEvidence"),
            state: "absent" as const,
            reason: t("activity.runInspector.reasons.noAssurance"),
          },
        ]
      : context.assurance.map((assurance, index) => ({
          label: t("activity.runInspector.facts.assuranceEvidenceItem", {
            index: String(index + 1),
          }),
          state: "present" as const,
          values: [
            { label: t("activity.runInspector.values.kind"), value: assurance.kind },
            { label: t("activity.runInspector.values.strength"), value: assurance.strength },
            {
              label: t("activity.runInspector.values.evidenceReference"),
              value: assurance.evidenceRef,
              mono: true,
            },
          ],
        }))),
    {
      label: t("activity.runInspector.facts.lineage"),
      state: lineage ? "present" : "absent",
      values: lineage
        ? [
            { label: t("activity.runInspector.values.depth"), value: lineage.depth },
            ...(lineage.parentRunId
              ? [
                  {
                    label: t("activity.runInspector.values.parentRunReference"),
                    value: lineage.parentRunId,
                    mono: true,
                    href: runInspectorHref(lineage.parentRunId, basePath),
                  },
                ]
              : []),
            ...(lineage.parentExecutionId
              ? [
                  {
                    label: t("activity.runInspector.values.parentExecutionReference"),
                    value: lineage.parentExecutionId,
                    mono: true,
                  },
                ]
              : []),
            ...(lineage.parentContextId
              ? [
                  {
                    label: t("activity.runInspector.values.parentContextReference"),
                    value: lineage.parentContextId,
                    mono: true,
                  },
                ]
              : []),
            ...(lineage.delegationRef
              ? [
                  {
                    label: t("activity.runInspector.values.delegationReference"),
                    value: lineage.delegationRef,
                    mono: true,
                  },
                ]
              : []),
            ...principalValues(lineage.parentAgentPrincipal),
          ]
        : [],
      reason: lineage ? undefined : t("activity.runInspector.reasons.noLineage"),
    },
  ];
}

function renderMissingEvidence(values: readonly string[]) {
  return html`
    <section class="run-inspector__section" aria-labelledby="run-inspector-missing-heading">
      <h3 id="run-inspector-missing-heading">
        ${t("activity.runInspector.missingEvidenceHeading")}
      </h3>
      ${values.length === 0
        ? html`<p>${t("activity.runInspector.noMissingEvidence")}</p>`
        : html`<ul class="run-inspector__code-list">
            ${values.map((value) => html`<li>${renderSafeRef(value, true)}</li>`)}
          </ul>`}
    </section>
  `;
}

function renderRemediation(
  remediation: readonly { code: string; text: string }[],
): TemplateResult | typeof nothing {
  if (remediation.length === 0) {
    return nothing;
  }
  return html`
    <section
      class="run-inspector__section"
      aria-label=${t("activity.runInspector.nextStepsHeading")}
    >
      <h3>${t("activity.runInspector.nextStepsHeading")}</h3>
      <ul class="run-inspector__remediation-list">
        ${remediation.map(
          (item) => html`<li><span>${item.text}</span> ${renderSafeRef(item.code, true)}</li>`,
        )}
      </ul>
    </section>
  `;
}

function renderDecisions(result: AuditRunInspectResult) {
  return html`
    <section class="run-inspector__section" aria-labelledby="run-inspector-decisions-heading">
      <h3 id="run-inspector-decisions-heading">${t("activity.runInspector.decisions.heading")}</h3>
      ${result.decisions.length === 0
        ? html`<p>${t("activity.runInspector.decisions.none")}</p>`
        : html`<p>
            ${t("activity.runInspector.decisions.returned", {
              count: String(result.decisions.length),
            })}
          </p>`}
      ${result.nextDecisionCursor
        ? html`<div class="run-inspector__pagination" role="note">
            ${t("activity.runInspector.decisions.more")}
          </div>`
        : html`<div class="run-inspector__pagination" role="note">
            ${t("activity.runInspector.decisions.bounded")}
          </div>`}
    </section>
  `;
}

function diagnosticCopy(result: AuditRunInspectResult) {
  const kind = classifyRunInspection(result);
  switch (kind) {
    case "not-found":
      return {
        title: t("activity.runInspector.diagnostic.notFound.title"),
        description: t("activity.runInspector.diagnostic.notFound.description"),
      };
    case "expired":
      return {
        title: t("activity.runInspector.diagnostic.expired.title"),
        description: t("activity.runInspector.diagnostic.expired.description"),
      };
    case "corrupt":
      return {
        title: t("activity.runInspector.diagnostic.corrupt.title"),
        description: t("activity.runInspector.diagnostic.corrupt.description"),
      };
    case "ambiguous":
      return {
        title: t("activity.runInspector.diagnostic.ambiguous.title"),
        description: t("activity.runInspector.diagnostic.ambiguous.description"),
      };
    case "unsupported":
      return {
        title: t("activity.runInspector.diagnostic.unsupported.title"),
        description: t("activity.runInspector.diagnostic.unsupported.description"),
      };
    case "unknown":
      return {
        title: t("activity.runInspector.diagnostic.unknown.title"),
        description: t("activity.runInspector.diagnostic.unknown.description"),
      };
    case "present":
      return null;
  }
  const unreachable: never = kind;
  return unreachable;
}

function renderUnavailableResult(result: AuditRunInspectResult, basePath: string) {
  const copy = diagnosticCopy(result);
  if (!copy || result.identity.state === "present") {
    return nothing;
  }
  const identity = result.identity;
  return html`
    <div class="run-inspector__result-state" role="status" aria-label=${copy.title}>
      <h3>${copy.title}</h3>
      <p>${copy.description}</p>
      <p>
        ${t("activity.runInspector.diagnosticReason")} ${renderSafeRef(identity.reasonCode, true)}
      </p>
    </div>
    ${identity.state === "ambiguous"
      ? html`
          <ol
            class="run-inspector__candidate-list"
            aria-label=${t("activity.runInspector.candidates.listLabel")}
          >
            ${identity.candidates.map(
              (candidate) => html`
                <li>
                  <span
                    >${t("activity.runInspector.candidates.recorded", {
                      date: new Date(candidate.createdAt).toLocaleString(),
                    })}</span
                  >
                  <a href=${executionInspectorHref(candidate.executionId, basePath)}>
                    ${t("activity.runInspector.candidates.executionReference")}
                    ${renderSafeRef(candidate.executionId, true)}
                  </a>
                </li>
              `,
            )}
          </ol>
          ${result.nextExecutionCursor
            ? html`<div class="run-inspector__pagination" role="note">
                ${t("activity.runInspector.candidates.more")}
              </div>`
            : nothing}
        `
      : nothing}
    ${renderMissingEvidence(identity.missingEvidence)} ${renderRemediation(identity.remediation)}
  `;
}

function renderReady(result: AuditRunInspectResult, basePath: string) {
  const currentCoverageLabel = coverageLabel(result.coverage.state);
  return html`
    <div
      class="run-inspector__coverage run-inspector__coverage--${result.coverage.state}"
      role="status"
      aria-label=${t("activity.runInspector.coverageStatusLabel", {
        state: currentCoverageLabel,
      })}
    >
      <strong>${currentCoverageLabel}</strong>
      <span>
        ${t(`activity.runInspector.coverage.${coverageKey(result.coverage.state)}.description`)}
      </span>
    </div>
    ${result.identity.state === "present"
      ? html`
          <section class="run-inspector__section" aria-labelledby="run-inspector-identity-heading">
            <h3 id="run-inspector-identity-heading">
              ${t("activity.runInspector.identityHeading")}
            </h3>
            <dl class="run-inspector__facts">
              ${identityFacts(result.identity.context, basePath).map(renderFact)}
            </dl>
          </section>
          ${renderMissingEvidence(result.coverage.missingEvidence)} ${renderDecisions(result)}
        `
      : renderUnavailableResult(result, basePath)}
  `;
}

function renderPanel(
  title: string,
  description: string,
  options: { retry?: boolean; onRetry: () => void; role?: "alert" | "status" },
) {
  return html`
    <div class="run-inspector__panel" role=${options.role ?? "status"}>
      <h3>${title}</h3>
      <p>${description}</p>
      ${options.retry
        ? html`<button type="button" class="btn" @click=${options.onRetry}>
            ${t("activity.runInspector.retry")}
          </button>`
        : nothing}
    </div>
  `;
}

export function renderRunInspector(props: RunInspectorProps) {
  const state = props.state;
  let content: TemplateResult;
  switch (state.status) {
    case "empty":
      content = renderPanel(
        t("activity.runInspector.panels.empty.title"),
        t("activity.runInspector.panels.empty.description"),
        { onRetry: props.onRetry },
      );
      break;
    case "loading":
      content = renderPanel(
        state.waitingForGateway
          ? t("activity.runInspector.panels.waiting.title")
          : t("activity.runInspector.panels.loading.title"),
        state.waitingForGateway
          ? t("activity.runInspector.panels.waiting.description")
          : t("activity.runInspector.panels.loading.description"),
        { onRetry: props.onRetry },
      );
      break;
    case "disconnected":
      content = renderPanel(
        t("activity.runInspector.panels.disconnected.title"),
        t("activity.runInspector.panels.disconnected.description"),
        { onRetry: props.onRetry },
      );
      break;
    case "unauthorized":
      content = renderPanel(
        t("activity.runInspector.panels.unauthorized.title"),
        t("activity.runInspector.panels.unauthorized.description"),
        { onRetry: props.onRetry, role: "alert" },
      );
      break;
    case "unsupported":
      content = renderPanel(
        t("activity.runInspector.panels.unsupported.title"),
        t("activity.runInspector.panels.unsupported.description"),
        { onRetry: props.onRetry },
      );
      break;
    case "error":
      content = renderPanel(
        t("activity.runInspector.panels.error.title"),
        t("activity.runInspector.panels.error.description"),
        { onRetry: props.onRetry, retry: true, role: "alert" },
      );
      break;
    case "ready":
      content = renderReady(state.result, props.basePath);
      break;
  }

  return html`
    <section
      id="activity-run-panel"
      class="run-inspector"
      aria-label=${t("activity.runInspector.mode")}
    >
      <div class="settings-section__header">
        <div>
          <h2 class="settings-section__heading">${t("activity.runInspector.mode")}</h2>
          <p class="run-inspector__intro">${t("activity.runInspector.intro")}</p>
        </div>
      </div>
      <div class="run-inspector__warning" role="note">
        ${t("activity.runInspector.bestEffortWarning")}
      </div>
      ${content}
    </section>
  `;
}
