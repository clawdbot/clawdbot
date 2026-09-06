import { html, nothing } from "lit";
import type { UpdateAvailable, UpdateScheduleState } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import "../styles/update-change-preview.css";

/** Display only the Gateway's existing preview, not inferred release notes. */
export function renderUpdateChangePreview(
  update: UpdateAvailable | null,
  schedule: UpdateScheduleState | null,
) {
  const target = schedule?.target;
  const comparison = schedule?.install?.git;
  const commits = update?.commits;
  if (
    !commits?.length ||
    target?.kind === "package" ||
    (!update?.currentSha && target?.kind !== "git") ||
    (target?.kind === "git" &&
      (target.commitsBehind !== update?.commitsBehind ||
        (update.upstreamSha && target.upstreamSha !== update.upstreamSha))) ||
    update?.commitsBehind === 0 ||
    (comparison &&
      ((comparison.status !== "behind" && comparison.status !== "diverged") ||
        comparison.commitsBehind !== update?.commitsBehind ||
        (comparison.currentSha &&
          update?.currentSha &&
          comparison.currentSha !== update.currentSha)))
  ) {
    return nothing;
  }
  const total = update?.commitsBehind;
  return html`<section class="update-change-preview" aria-label=${t("updates.preview.title")}>
    <div class="update-change-preview__title">${t("updates.preview.title")}</div>
    ${
      total !== undefined && total > commits.length
        ? html`<p class="update-change-preview__count">
            ${t("updates.preview.partial", { shown: String(commits.length), total: String(total) })}
          </p>`
        : nothing
    }
    <ul class="update-change-preview__list">
      ${commits.map(
        (commit) => html`<li>
          <span>${commit.subject}</span><code title=${commit.sha}>${commit.sha}</code>
        </li>`,
      )}
    </ul>
  </section>`;
}
