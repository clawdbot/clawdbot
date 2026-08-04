import { html, nothing } from "lit";
import { t } from "../i18n/index.ts";
import "../styles/cron-jobs-pagination.css";

export function renderCronJobsPagination(params: {
  jobsShown: number;
  jobsTotal: number;
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  return html`
    <div class="cron-table__footer">
      <span class="muted">
        ${t("cron.list.shownOf", {
          shown: String(params.jobsShown),
          total: String(Math.max(params.jobsTotal, params.jobsShown)),
        })}
      </span>
      ${params.hasMore
        ? html`
            <button
              class="btn btn--sm cron-load-more"
              ?disabled=${params.loading || params.loadingMore}
              @click=${params.onLoadMore}
            >
              ${params.loadingMore ? t("cron.list.loading") : t("cron.list.loadMore")}
            </button>
          `
        : nothing}
    </div>
  `;
}
