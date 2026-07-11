import type { Router } from "@openclaw/uirouter";
import { html, nothing } from "lit";
import type { ReactiveController, ReactiveControllerHost } from "lit";
import { property } from "lit/decorators.js";
import { t } from "../i18n/index.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import {
  RouterOutletController,
  selectRenderedRouteMatch,
  type RouterOutletSnapshot,
} from "./router-outlet-controller.ts";
import {
  isStaleChunkImportError,
  retryStaleChunkReload,
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
  const handleRetry = () => {
    if (!staleChunk) {
      revalidate();
      return;
    }
    // Reload only when the gateway is reachable; during a restart fall back to
    // revalidation so the panel error stays recoverable inside app webviews.
    void retryStaleChunkReload().then((reloading) => {
      if (!reloading) {
        revalidate();
      }
    });
  };
  return html`
    ${render?.() ?? nothing}
    <div class="callout danger" role="alert">
      <strong>${t("lazyView.errorTitle")}</strong>
      <div>${routeError}</div>
      ${staleChunk ? html`<div>${t("lazyView.errorSubtitle")}</div>` : nothing}
      <button class="btn btn--sm" @click=${handleRetry}>${t("lazyView.retry")}</button>
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

  override render() {
    if (!this.router) {
      return nothing;
    }
    return renderRouterOutlet(this.router, this.outlet.snapshot, {
      retryContext: this.retryContext,
    });
  }
}

if (!customElements.get("openclaw-router-outlet")) {
  customElements.define("openclaw-router-outlet", OpenClawRouterOutlet);
}
