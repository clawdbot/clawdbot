import type { Router } from "@openclaw/uirouter";
import { html, nothing } from "lit";
import type { ReactiveController, ReactiveControllerHost } from "lit";
import { property } from "lit/decorators.js";
import { icon } from "../components/icons.ts";
import { McpAppUnmountGate } from "../components/mcp-app-unmount.ts";
import { t } from "../i18n/index.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import {
  RouterOutletController,
  selectRenderedRouteMatch,
  type RouterOutletSnapshot,
} from "./router-outlet-controller.ts";
import {
  isStaleChunkImportError,
  retryStaleChunkReloadWhenReachable,
  scheduleStaleChunkReload,
} from "./stale-chunk-reload.ts";

export { selectRenderedRouteMatch } from "./router-outlet-controller.ts";

type RenderableModule<TData> = {
  render: (data: TData | undefined) => unknown;
};

type RouterOutletOptions<TLoadContext = unknown> = {
  retryContext?: TLoadContext;
};

function isRenderableModule<TData>(module: unknown): module is RenderableModule<TData> {
  return (
    typeof module === "object" &&
    module !== null &&
    "render" in module &&
    typeof module.render === "function"
  );
}

function measureRoutedRender<T>(routeId: string, render: () => T): T {
  const startedAt = globalThis.performance?.now() ?? 0;
  const result = render();
  const durationMs = Math.round((globalThis.performance?.now() ?? startedAt) - startedAt);
  if (durationMs >= 16) {
    console.debug("[openclaw] routed render", { routeId, durationMs });
  }
  return result;
}

function renderPending() {
  return html`
    <section class="card lazy-view-state lazy-view-state--loading" role="status">
      <div class="card-title">${t("lazyView.loadingTitle")}</div>
      <div class="card-sub">${t("common.loading")}</div>
    </section>
  `;
}

/**
 * Shows progress while waiting for the restarting gateway. The state lives on
 * the element rather than in render state because the reload replaces the
 * document; a re-render that resets the label is harmless, since the pending
 * wait still reloads on its own once the gateway answers.
 */
function markButtonReloading(button: HTMLButtonElement | null): () => void {
  if (!button) {
    return () => {};
  }
  const label = button.textContent;
  button.disabled = true;
  button.textContent = t("lazyView.reloading");
  return () => {
    button.disabled = false;
    button.textContent = label;
  };
}

function renderError<TRouteId extends string, TLoadContext, TModule, TData>(
  router: Router<TRouteId, TLoadContext, TModule, TData>,
  retryContext: TLoadContext | undefined,
  error: unknown,
  routeId: TRouteId,
  render?: () => unknown,
) {
  const routeError = error instanceof Error ? error.message : String(error);
  const staleChunk = isStaleChunkImportError(error);
  if (staleChunk) {
    // The chunk this document references was replaced by a newer build;
    // revalidate cannot fix that, only a reload against the fresh index.html.
    void scheduleStaleChunkReload();
  }
  const revalidate = () => {
    if (retryContext === undefined) {
      return;
    }
    void router.revalidate(retryContext, routeId).catch(() => undefined);
  };
  const handleRetry = (event: Event) => {
    if (!staleChunk) {
      revalidate();
      return;
    }
    // The gateway is usually still restarting when this is clicked (that update
    // is what stranded the chunk), so wait for it to answer and then reload
    // instead of declining on the first failed probe — a silent no-op here is
    // what drives people to a manual hard reload. Reloading against an
    // unreachable gateway would replace the recoverable panel error with a
    // fatal navigation error in app webviews, so the wait is still bounded.
    const button = event.currentTarget instanceof HTMLButtonElement ? event.currentTarget : null;
    const restoreButton = markButtonReloading(button);
    void retryStaleChunkReloadWhenReachable().then((reloading) => {
      if (reloading) {
        return;
      }
      restoreButton();
      revalidate();
    });
  };
  // Stale-chunk failures are routine after a gateway update, so present them
  // as an update prompt instead of a generic failure.
  const errorClasses = [
    "lazy-view-error",
    render ? "lazy-view-error--inline" : "",
    staleChunk ? "lazy-view-error--stale" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return html`
    ${render?.() ?? nothing}
    <div class=${errorClasses} role="alert">
      <div class="lazy-view-error__icon" aria-hidden="true">
        ${icon(staleChunk ? "refresh" : "alertTriangle")}
      </div>
      <div class="lazy-view-error__title">
        ${staleChunk ? t("lazyView.staleTitle") : t("lazyView.errorTitle")}
      </div>
      <div class="lazy-view-error__subtitle">
        ${staleChunk ? t("lazyView.staleSubtitle") : t("lazyView.genericSubtitle")}
      </div>
      <button class="btn lazy-view-error__action" @click=${handleRetry}>
        ${staleChunk ? t("common.reload") : t("lazyView.retry")}
      </button>
      <code class="lazy-view-error__detail">${routeError}</code>
    </div>
  `;
}

function renderRouterOutlet<TRouteId extends string, TLoadContext, TModule, TData = unknown>(
  router: Router<TRouteId, TLoadContext, TModule, TData>,
  selection: RouterOutletSnapshot<TRouteId, TModule, TData>,
  options: RouterOutletOptions<TLoadContext> = {},
): unknown {
  const pending = selection.pending;
  const renderedMatch = selectRenderedRouteMatch(selection.active, pending);
  if (renderedMatch?.status === "notFound") {
    return nothing;
  }
  if (renderedMatch?.status === "redirected") {
    return nothing;
  }
  if (!renderedMatch) {
    return nothing;
  }

  const routeId = renderedMatch.routeId;
  if (!renderedMatch?.module) {
    return renderedMatch.error
      ? renderError<TRouteId, TLoadContext, TModule, TData>(
          router,
          options.retryContext,
          renderedMatch.error,
          routeId,
        )
      : selection.showPending
        ? renderPending()
        : nothing;
  }
  const routeModule = renderedMatch.module;
  if (!isRenderableModule<TData>(routeModule)) {
    return renderedMatch.error
      ? renderError<TRouteId, TLoadContext, TModule, TData>(
          router,
          options.retryContext,
          renderedMatch.error,
          routeId,
        )
      : null;
  }
  const renderedPage = () =>
    measureRoutedRender(routeId, () => routeModule.render(renderedMatch.data));
  return renderedMatch.error
    ? renderError<TRouteId, TLoadContext, TModule, TData>(
        router,
        options.retryContext,
        renderedMatch.error,
        routeId,
        renderedPage,
      )
    : renderedPage();
}

type RouterOutletInputs<TRouteId extends string, TLoadContext, TModule, TData> = {
  router?: Router<TRouteId, TLoadContext, TModule, TData>;
  onNotFound?: () => void;
};

class LitRouterOutletController<
  TRouteId extends string,
  TLoadContext,
  TModule,
  TData,
> implements ReactiveController {
  private readonly controller: RouterOutletController<TRouteId, TLoadContext, TModule, TData>;

  constructor(
    host: ReactiveControllerHost,
    private readonly inputs: () => RouterOutletInputs<TRouteId, TLoadContext, TModule, TData>,
  ) {
    this.controller = new RouterOutletController(() => host.requestUpdate());
    host.addController(this);
  }

  get snapshot(): RouterOutletSnapshot<TRouteId, TModule, TData> {
    return this.controller.snapshot;
  }

  hostConnected(): void {
    this.controller.setInputs(this.inputs());
    this.controller.connect();
  }

  hostUpdate(): void {
    this.controller.setInputs(this.inputs());
  }

  hostDisconnected(): void {
    this.controller.disconnect();
  }
}

class OpenClawRouterOutlet<
  TRouteId extends string = string,
  TLoadContext = unknown,
  TModule = unknown,
  TData = unknown,
> extends OpenClawLightDomElement {
  @property({ attribute: false }) router?: Router<TRouteId, TLoadContext, TModule, TData>;
  @property({ attribute: false }) retryContext?: TLoadContext;
  @property({ attribute: false }) onNotFound?: () => void;
  private readonly outlet = new LitRouterOutletController(this, () => ({
    router: this.router,
    onNotFound: this.onNotFound,
  }));
  private readonly mcpAppUnmountGate = new McpAppUnmountGate(this);

  override render() {
    if (!this.router) {
      return nothing;
    }
    const snapshot = this.outlet.snapshot;
    const renderedMatch = selectRenderedRouteMatch(snapshot.active, snapshot.pending);
    const rendered = renderRouterOutlet(this.router, snapshot, {
      retryContext: this.retryContext,
    });
    return this.mcpAppUnmountGate.render(
      renderedMatch ? `${renderedMatch.routeId}:${renderedMatch.status}` : "empty",
      rendered,
      () => [this],
    );
  }
}

if (!customElements.get("openclaw-router-outlet")) {
  customElements.define("openclaw-router-outlet", OpenClawRouterOutlet);
}
