import { html } from "lit";
import { t } from "../i18n/index.ts";

type LazyState<T> = {
  mod: T | null;
  promise: Promise<void> | null;
  error: unknown;
  hasError: boolean;
};

export type LazyView<T> = {
  read: () => T | null;
  retry: () => void;
  error: () => unknown;
  hasError: () => boolean;
  pending: () => boolean;
};

export function createLazyView<T>(loader: () => Promise<T>, onChange?: () => void): LazyView<T> {
  const state: LazyState<T> = { mod: null, promise: null, error: undefined, hasError: false };

  const load = () => {
    state.promise = loader()
      .then(
        (mod) => {
          state.mod = mod;
          state.error = undefined;
          state.hasError = false;
        },
        (error: unknown) => {
          state.error = error;
          state.hasError = true;
          state.promise = null;
        },
      )
      .finally(() => {
        onChange?.();
      });
  };

  return {
    read: () => {
      if (state.mod !== null) {
        return state.mod;
      }
      if (!state.promise && !state.hasError) {
        load();
      }
      return null;
    },
    retry: () => {
      if (state.mod !== null) {
        return;
      }
      state.error = undefined;
      state.hasError = false;
      state.promise = null;
      load();
      onChange?.();
    },
    error: () => state.error,
    hasError: () => state.hasError,
    pending: () => state.promise !== null,
  };
}

function formatLazyViewError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  return t("lazyView.unknownError");
}

export function renderLazyView<M>(view: LazyView<M>, render: (mod: M) => unknown) {
  const mod = view.read();
  if (mod !== null) {
    return render(mod);
  }

  if (view.hasError()) {
    const error = view.error();
    return html`
      <section class="card lazy-view-state lazy-view-state--error">
        <div class="card-title">${t("lazyView.errorTitle")}</div>
        <div class="card-sub">${t("lazyView.errorSubtitle")}</div>
        <div class="callout danger" style="margin-top: 12px;">${formatLazyViewError(error)}</div>
        <div style="display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap;">
          <button class="btn primary" @click=${() => globalThis.location.reload()}>
            ${t("common.reload")}
          </button>
          <button class="btn" @click=${() => view.retry()}>${t("lazyView.retry")}</button>
        </div>
      </section>
    `;
  }

  return html`
    <section class="card lazy-view-state lazy-view-state--loading">
      <div class="card-title">${t("lazyView.loadingTitle")}</div>
      <div class="card-sub">${t("common.loading")}</div>
    </section>
  `;
}
