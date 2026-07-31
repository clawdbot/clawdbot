import { badgeHtml, esc, formatIso, statusTone } from "./ui-render-utils.js";
import type {
  EvidenceArtifactView,
  EvidenceEntryView,
  EvidenceMatrixCell,
  EvidenceProducerContext,
  EvidenceProducerContextFile,
  UiState,
} from "./ui-types.js";

function evidenceEntryMatches(state: UiState, entry: EvidenceEntryView): boolean {
  if (state.evidenceStatusFilter !== "all" && entry.status !== state.evidenceStatusFilter) {
    return false;
  }
  if (
    state.evidenceArtifactFilter !== "all" &&
    !entry.artifacts.some((artifact) => artifact.mediaKind === state.evidenceArtifactFilter)
  ) {
    return false;
  }
  const query = state.evidenceSearchText.trim().toLowerCase();
  if (!query) {
    return true;
  }
  const haystack = [
    entry.id,
    entry.title,
    entry.kind,
    entry.sourcePath ?? "",
    ...entry.coverage.map((coverage) => `${coverage.id} ${coverage.role}`),
    ...entry.artifacts.map((artifact) => `${artifact.kind} ${artifact.source} ${artifact.path}`),
  ]
    .join("\n")
    .toLowerCase();
  return haystack.includes(query);
}

function renderEvidenceMetric(label: string, value: string | number, tone?: string): string {
  return `<div class="evidence-metric${tone ? ` evidence-metric-${esc(tone)}` : ""}">
    <span>${esc(label)}</span>
    <strong>${esc(String(value))}</strong>
  </div>`;
}

function renderEvidenceCoverage(entry: EvidenceEntryView): string {
  if (entry.coverage.length === 0) {
    return '<span class="text-dimmed text-sm">No coverage IDs</span>';
  }
  return entry.coverage
    .map(
      (coverage) =>
        `<span class="capture-chip">${esc(coverage.id)} <em>${esc(coverage.role)}</em></span>`,
    )
    .join("");
}

function renderEvidenceArtifactBadge(artifact: EvidenceArtifactView): string {
  const missing = artifact.exists ? "" : " evidence-artifact-badge-missing";
  return `<span class="evidence-artifact-badge${missing}" title="${esc(artifact.path)}">${esc(artifact.kind)}</span>`;
}

function renderEvidenceEntryButton(entry: EvidenceEntryView, selected: boolean): string {
  const artifactSummary =
    entry.artifacts.length > 0
      ? entry.artifacts.map(renderEvidenceArtifactBadge).join("")
      : '<span class="text-dimmed text-sm">No artifacts</span>';
  return `<button class="evidence-entry-card${selected ? " selected" : ""}" data-evidence-entry-id="${esc(entry.id)}" type="button">
    <div class="evidence-entry-card-top">
      <span class="result-card-dot scenario-item-dot-${statusTone(entry.status)}"></span>
      <div>
        <div class="evidence-entry-title">${esc(entry.title)}</div>
        <div class="evidence-entry-meta">${esc(entry.kind)} · ${esc(entry.id)}</div>
      </div>
      ${badgeHtml(entry.status)}
    </div>
    <div class="evidence-entry-artifacts">${artifactSummary}</div>
  </button>`;
}

function renderEvidenceArtifactBody(artifact: EvidenceArtifactView): string {
  if (!artifact.exists || !artifact.href) {
    return `<div class="empty-state">Artifact unavailable: ${esc(artifact.error ?? "missing")}</div>`;
  }
  const isInlineScreenshot =
    artifact.mediaKind === "image" && artifact.kind.toLowerCase().includes("screenshot");
  if (isInlineScreenshot) {
    return `<a href="${esc(artifact.href)}" target="_blank" rel="noopener noreferrer"><img src="${esc(artifact.href)}" alt="${esc(artifact.kind)} artifact" loading="lazy" /></a>`;
  }
  if (artifact.mediaKind === "image" || artifact.mediaKind === "video") {
    const noun = artifact.mediaKind === "video" ? "Video" : "Media";
    return `<div class="evidence-artifact-deferred">
      <span>${noun} preview is deferred to keep the evidence view responsive.</span>
      <a class="btn-sm" href="${esc(artifact.href)}" target="_blank" rel="noopener noreferrer">Open ${noun.toLowerCase()} artifact</a>
    </div>`;
  }
  if (artifact.preview !== null) {
    return `<details class="evidence-artifact-preview-shell">
      <summary>Preview ${esc(artifact.kind)}</summary>
      <pre class="report-pre evidence-artifact-preview">${esc(artifact.preview)}</pre>
    </details>`;
  }
  return `<a class="btn-sm" href="${esc(artifact.href)}" target="_blank" rel="noopener noreferrer">Open artifact</a>`;
}

function renderEvidenceArtifactCard(artifact: EvidenceArtifactView): string {
  return `<article class="evidence-artifact-card evidence-artifact-card-${artifact.mediaKind}">
    <header>
      <div>
        <div class="evidence-artifact-title">${esc(artifact.kind)}</div>
        <div class="evidence-artifact-source">${esc(artifact.source)}</div>
      </div>
      ${artifact.href ? `<a class="btn-sm btn-ghost" href="${esc(artifact.href)}" target="_blank" rel="noopener noreferrer">Open</a>` : ""}
    </header>
    ${renderEvidenceArtifactBody(artifact)}
    <footer title="${esc(artifact.path)}">${esc(artifact.path)}</footer>
  </article>`;
}

function renderEvidenceDetail(entry: EvidenceEntryView | null): string {
  if (!entry) {
    return '<div class="inspector-empty">Select an evidence entry</div>';
  }
  return `<div class="evidence-detail">
    <header class="evidence-detail-header">
      <div>
        <div class="inspector-section-title">${esc(entry.kind)}</div>
        <h2>${esc(entry.title)}</h2>
        <div class="evidence-entry-meta">${esc(entry.id)}</div>
      </div>
      ${badgeHtml(entry.status)}
    </header>
    ${entry.failureReason ? `<div class="capture-error">${esc(entry.failureReason)}</div>` : ""}
    <section class="evidence-detail-section">
      <div class="inspector-section-title">Coverage</div>
      <div class="capture-chip-row">${renderEvidenceCoverage(entry)}</div>
    </section>
    ${
      entry.sourcePath
        ? `<section class="evidence-detail-section">
            <div class="inspector-section-title">Source</div>
            <div class="capture-mono evidence-source-path">${esc(entry.sourcePath)}</div>
          </section>`
        : ""
    }
    <section class="evidence-detail-section evidence-detail-section-artifacts">
      <div class="inspector-section-title">Artifacts</div>
      ${
        entry.artifacts.length > 0
          ? `<div class="evidence-artifact-grid">${entry.artifacts.map(renderEvidenceArtifactCard).join("")}</div>`
          : '<div class="empty-state">No execution artifacts recorded for this entry.</div>'
      }
    </section>
  </div>`;
}

function renderProducerContextMetric(label: string, value: string | number): string {
  return `<div class="evidence-producer-metric">
    <span>${esc(label)}</span>
    <strong>${esc(String(value))}</strong>
  </div>`;
}

function renderProducerCountChips(counts: Record<string, number>): string {
  const entries = Object.entries(counts).toSorted(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  );
  if (entries.length === 0) {
    return '<span class="text-dimmed text-sm">No counts recorded</span>';
  }
  return entries
    .map(
      ([status, count]) =>
        `<span class="capture-chip">${esc(status)} <em>${esc(String(count))}</em></span>`,
    )
    .join("");
}

function renderProducerContextFile(params: {
  file: EvidenceProducerContextFile | null;
  open?: boolean;
  title: string;
}): string {
  if (!params.file) {
    return "";
  }
  return `<details class="evidence-producer-drilldown" ${params.open ? "open" : ""}>
    <summary>
      <span>${esc(params.title)}</span>
      <span class="capture-mono">${esc(params.file.path)}</span>
    </summary>
    <div class="evidence-producer-drilldown-body">
      ${
        params.file.preview !== null
          ? `<pre class="report-pre evidence-producer-preview">${esc(params.file.preview)}</pre>`
          : '<div class="empty-state">Preview unavailable for this artifact.</div>'
      }
      <a class="btn-sm btn-ghost" href="${esc(params.file.href)}" target="_blank" rel="noopener noreferrer">Open artifact</a>
    </div>
  </details>`;
}

function formatMatrixLabel(id: string): string {
  return id
    .split("-")
    .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(" ");
}

function matrixCellClass(status: string): string {
  return status.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
}

function renderEvidenceMatrixCell(
  cell: EvidenceMatrixCell | undefined,
  surface: string,
  stage: string,
): string {
  if (!cell) {
    return '<span class="evidence-matrix-cell evidence-matrix-cell-missing" title="No matrix cell was recorded for this surface and stage.">-</span>';
  }
  const isProofGap = cell.status === "proof-gap";
  const artifactText =
    cell.artifactPaths.length > 0 ? ` Artifacts: ${cell.artifactPaths.join(", ")}` : "";
  const proofText =
    cell.artifactKinds.length > 0
      ? ` Proof: ${cell.artifactKinds.join(" + ")} (${cell.artifactPaths.length})`
      : "";
  const coverageText =
    cell.coverageIds.length > 0 ? ` Coverage: ${cell.coverageIds.join(", ")}` : "";
  const runnerText = cell.runner?.lane
    ? ` Runner: ${cell.runner.lane}${cell.runner.workflow ? ` via ${cell.runner.workflow}` : ""}${cell.runner.command ? `; ${cell.runner.command}` : ""}`
    : "";
  const title = `${surface} / ${stage}: ${cell.status}${isProofGap ? " (not executed in this run)" : ""}.${coverageText}${runnerText ? ` ${runnerText}` : ""}${proofText}${artifactText}`;
  const className = `evidence-matrix-cell evidence-matrix-cell-${matrixCellClass(cell.status)}${cell.testId ? " evidence-matrix-cell-action" : ""}`;
  const label = isProofGap ? "gap" : cell.status;
  if (!cell.testId) {
    return `<span class="${className}" title="${esc(title)}">${esc(label)}</span>`;
  }
  return `<button class="${className}" data-evidence-entry-id="${esc(cell.testId)}" type="button" title="${esc(cell.title ?? title)}">${esc(label)}</button>`;
}

function renderEvidenceMatrixMiniGrid(matrix: EvidenceProducerContext["matrix"]): string {
  if (!matrix || matrix.cells.length === 0) {
    return "";
  }
  const cellsByKey = new Map(
    matrix.cells.map((cell) => [`${cell.surface}:${cell.stage}`, cell] as const),
  );
  return `<div class="evidence-matrix-mini" aria-label="UX Matrix surface by stage evidence grid">
    <table>
      <thead>
        <tr>
          <th scope="col">Surface</th>
          ${matrix.stages.map((stage) => `<th scope="col" title="${esc(stage)}">${esc(formatMatrixLabel(stage))}</th>`).join("")}
        </tr>
      </thead>
      <tbody>
        ${matrix.surfaces
          .map(
            (surface) => `<tr>
              <th scope="row" title="${esc(surface)}">${esc(formatMatrixLabel(surface))}</th>
              ${matrix.stages
                .map(
                  (stage) =>
                    `<td>${renderEvidenceMatrixCell(cellsByKey.get(`${surface}:${stage}`), surface, stage)}</td>`,
                )
                .join("")}
            </tr>`,
          )
          .join("")}
      </tbody>
    </table>
  </div>`;
}

function renderEvidenceProducerContext(producer: EvidenceProducerContext | null): string {
  if (!producer) {
    return "";
  }
  const matrix = producer.matrix;
  const counts = matrix?.counts ?? {};
  const proofGaps = counts["proof-gap"] ?? 0;
  const issueCount =
    (counts.fail ?? 0) +
    (counts.blocked ?? 0) +
    (counts["automation-issue"] ?? 0) +
    (counts["environment-issue"] ?? 0);
  return `<section class="evidence-producer-panel">
    <div class="evidence-producer-head">
      <div>
        <div class="inspector-section-title">Producer context</div>
        <h2>UX journey matrix</h2>
        <p>Matrix context from the evidence producer. Proof gaps mean this run did not execute those cells.</p>
      </div>
      <div class="evidence-producer-run">
        ${producer.manifest?.runStatus ? badgeHtml(producer.manifest.runStatus) : ""}
        ${producer.manifest?.runId ? `<span class="capture-mono">${esc(producer.manifest.runId)}</span>` : ""}
      </div>
    </div>
    <div class="evidence-producer-grid">
      ${renderProducerContextMetric("Cells", matrix?.cells.length ?? 0)}
      ${renderProducerContextMetric("Pass", counts.pass ?? 0)}
      ${renderProducerContextMetric("Proof gaps", proofGaps)}
      ${renderProducerContextMetric("Issues", issueCount)}
      ${renderProducerContextMetric("Surfaces", matrix?.surfaces.length ?? 0)}
      ${renderProducerContextMetric("Stages", matrix?.stages.length ?? 0)}
    </div>
    <div class="evidence-producer-status-row">
      <div>
        <div class="inspector-section-title">Matrix counts</div>
        <div class="capture-chip-row">${renderProducerCountChips(matrix?.counts ?? {})}</div>
      </div>
      ${
        producer.releaseLedger
          ? `<div>
              <div class="inspector-section-title">Release ledger counts</div>
              <div class="capture-chip-row">${renderProducerCountChips(producer.releaseLedger.counts)}</div>
            </div>`
          : ""
      }
    </div>
    <div class="evidence-producer-drilldowns">
      ${renderProducerContextFile({ title: "Scorecard", file: producer.scorecard, open: true })}
      ${renderProducerContextFile({ title: "Commands", file: producer.commands })}
      ${renderProducerContextFile({ title: "Preflight memory", file: producer.preflight.memory })}
      ${renderProducerContextFile({
        title: "Preflight adb devices",
        file: producer.preflight.adbDevices,
      })}
      ${renderProducerContextFile({ title: "Manifest", file: producer.manifest })}
      ${renderProducerContextFile({ title: "Release ledger", file: producer.releaseLedger })}
    </div>
    ${
      matrix
        ? `<div class="evidence-producer-links">
      <span class="ref-tag">${esc(matrix.path)}</span>
    </div>`
        : ""
    }
    ${renderEvidenceMatrixMiniGrid(matrix)}
  </section>`;
}

export function renderEvidenceView(state: UiState): string {
  const evidence = state.evidence;
  const entries = evidence?.entries.filter((entry) => evidenceEntryMatches(state, entry)) ?? [];
  const selected =
    entries.find((entry) => entry.id === state.selectedEvidenceEntryId) ??
    evidence?.entries.find((entry) => entry.id === state.selectedEvidenceEntryId) ??
    entries[0] ??
    null;
  const artifactCount =
    evidence?.entries.reduce((sum, entry) => sum + entry.artifacts.length, 0) ?? 0;
  const missingCount =
    evidence?.entries.reduce(
      (sum, entry) => sum + entry.artifacts.filter((artifact) => !artifact.exists).length,
      0,
    ) ?? 0;
  return `<div class="evidence-view">
    <div class="evidence-toolbar">
      <div class="evidence-toolbar-intro">
        <div class="inspector-section-title">Evidence Archive</div>
        <p>Saved QA evidence bundles, proof artifacts, logs, and producer context.</p>
      </div>
      <div class="evidence-toolbar-main">
        <label class="capture-search-field">Evidence path
          <input id="evidence-path" value="${esc(state.evidencePathDraft)}" placeholder=".artifacts/qa-e2e/suite-.../qa-evidence.json" />
        </label>
        <button class="btn-primary" data-action="load-evidence"${state.evidenceLoading ? " disabled" : ""}>Load</button>
      </div>
      <div class="evidence-filters">
        <label>Status
          <select id="evidence-status-filter">
            ${(["all", "fail", "blocked", "pass", "skipped"] as const)
              .map(
                (status) =>
                  `<option value="${status}"${state.evidenceStatusFilter === status ? " selected" : ""}>${status}</option>`,
              )
              .join("")}
          </select>
        </label>
        <label>Artifact
          <select id="evidence-artifact-filter">
            ${(["all", "image", "video", "json", "text", "file"] as const)
              .map(
                (kind) =>
                  `<option value="${kind}"${state.evidenceArtifactFilter === kind ? " selected" : ""}>${kind}</option>`,
              )
              .join("")}
          </select>
        </label>
        <label class="capture-search-field">Search
          <input id="evidence-search" value="${esc(state.evidenceSearchText)}" placeholder="coverage, title, artifact..." />
        </label>
      </div>
    </div>
    ${state.evidenceError ? `<div class="error-banner">${esc(state.evidenceError)}</div>` : ""}
    ${
      evidence
        ? `<div class="evidence-summary-row">
            ${renderEvidenceMetric("Pass", evidence.counts.pass, "pass")}
            ${renderEvidenceMetric("Fail", evidence.counts.fail, "fail")}
            ${renderEvidenceMetric("Blocked", evidence.counts.blocked, "blocked")}
            ${renderEvidenceMetric("Skipped", evidence.counts.skipped, "skipped")}
            ${renderEvidenceMetric("Artifacts", artifactCount)}
            ${renderEvidenceMetric("Missing", missingCount, missingCount > 0 ? "fail" : undefined)}
          </div>
          ${renderEvidenceProducerContext(evidence.producerContext)}
          <div class="evidence-meta-line">
            <span class="capture-mono">${esc(evidence.evidencePath)}</span>
            <span>schema v${evidence.schemaVersion}</span>
            <span>${esc(evidence.evidenceMode)}</span>
            ${evidence.profile ? `<span>profile ${esc(evidence.profile)}</span>` : ""}
            <span>${esc(formatIso(evidence.generatedAt))}</span>
          </div>
          <div class="evidence-workspace">
            <aside class="evidence-list">
              <div class="evidence-list-header">
                <span>${entries.length} visible</span>
                <span>${evidence.entries.length} total</span>
              </div>
              <div class="evidence-list-scroll">
                ${
                  entries.length > 0
                    ? entries
                        .map((entry) => renderEvidenceEntryButton(entry, entry.id === selected?.id))
                        .join("")
                    : '<div class="empty-state">No evidence entries match these filters.</div>'
                }
              </div>
            </aside>
            <section class="evidence-inspector">
              ${renderEvidenceDetail(selected)}
            </section>
          </div>`
        : `<div class="evidence-empty">
            <h2>No evidence loaded</h2>
            <p>Load a QA Lab <code>qa-evidence.json</code> file or a suite artifact directory to inspect entries, coverage IDs, screenshots, video, logs, and machine-validation artifacts.</p>
          </div>`
    }
  </div>`;
}
