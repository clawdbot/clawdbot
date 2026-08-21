import {
  isStaleChunkImportError,
  retryStaleChunkReloadWhenReachable,
} from "./stale-chunk-reload.ts";

type CustomElementModuleLoader = () => Promise<unknown>;

const pendingLoads = new Map<string, Promise<void>>();

/** Load a custom-element module once and verify that it registered its tag. */
export function ensureCustomElementDefined(
  tagName: string,
  loadModule: CustomElementModuleLoader,
): Promise<void> {
  if (customElements.get(tagName)) {
    return Promise.resolve();
  }
  const pending = pendingLoads.get(tagName);
  if (pending) {
    return pending;
  }
  const load = Promise.resolve()
    .then(loadModule)
    .then(() => {
      if (!customElements.get(tagName)) {
        throw new Error(`Custom element module did not define ${tagName}`);
      }
    })
    .finally(() => {
      pendingLoads.delete(tagName);
    });
  pendingLoads.set(tagName, load);
  return load;
}

export type OptionalCustomElement = {
  tagName: string;
  label: string;
  loadModule: () => Promise<unknown>;
};

type UpdatingHost = {
  requestUpdate: () => unknown;
  readonly updateComplete?: Promise<unknown>;
};

type LazyCustomElementRequestState =
  | { status: "loading"; element: OptionalCustomElement }
  | {
      status: "error";
      element: OptionalCustomElement;
      error: unknown;
      stale: boolean;
    };

type LazyCustomElementRequest = LazyCustomElementRequestState & {
  action?: () => void;
};

/** Owns visible lazy-element requests while global registration stays deduplicated by tag. */
export class LazyCustomElementRequestController {
  private current: LazyCustomElementRequest | undefined;
  private readonly preloads = new Set<string>();
  private active: OptionalCustomElement | undefined;
  private activeDismissed = false;

  constructor(
    private readonly host: UpdatingHost,
    private readonly onClose?: () => void,
    private readonly retryStale = retryStaleChunkReloadWhenReachable,
  ) {}

  get visibleState(): LazyCustomElementRequestState | undefined {
    return this.current;
  }

  preload(element: OptionalCustomElement): void {
    if (isOptionalElementDefined(element) || this.preloads.has(element.tagName)) {
      return;
    }
    this.preloads.add(element.tagName);
    void ensureCustomElementDefined(element.tagName, element.loadModule)
      .then(
        () => this.host.requestUpdate(),
        () => undefined,
      )
      .finally(() => this.preloads.delete(element.tagName));
  }

  request(element: OptionalCustomElement, action?: () => void): void {
    const request = {
      action,
      element,
      status: "loading",
    } satisfies LazyCustomElementRequest;
    this.current = request;
    this.host.requestUpdate();
    this.load(request);
  }

  requestWhileActive(element: OptionalCustomElement, active: boolean): void {
    if (active) {
      if (this.active !== element) {
        this.active = element;
        this.activeDismissed = false;
      }
    } else if (this.active === element) {
      this.active = undefined;
      this.activeDismissed = false;
    }
    if (!active && this.current?.element === element) {
      this.abandon();
    } else {
      this.pumpActive();
    }
  }

  retry(): void {
    const request = this.current;
    if (request?.status !== "error") {
      return;
    }
    const retryRequest = {
      action: request.action,
      element: request.element,
      status: "loading",
    } satisfies LazyCustomElementRequest;
    this.current = retryRequest;
    this.host.requestUpdate();
    void (request.stale ? this.retryStale() : Promise.resolve(false)).then((reloading) => {
      if (!reloading && this.current === retryRequest) {
        this.load(retryRequest);
      }
    });
  }

  close(): void {
    if (this.current) {
      if (this.current.element === this.active) {
        this.activeDismissed = true;
      }
      this.onClose?.();
      this.abandon();
    }
  }

  abandon(): void {
    if (this.current) {
      this.current = undefined;
      this.host.requestUpdate();
      this.pumpActive();
    }
  }

  private pumpActive(): void {
    if (
      this.active &&
      !this.activeDismissed &&
      !this.current &&
      !isOptionalElementDefined(this.active)
    ) {
      this.request(this.active);
    }
  }

  private load(request: LazyCustomElementRequest): void {
    void ensureCustomElementDefined(request.element.tagName, request.element.loadModule).then(
      async () => {
        if (this.current !== request) {
          return;
        }
        this.host.requestUpdate();
        await this.host.updateComplete;
        if (this.current === request) {
          request.action?.();
          if (this.current === request) {
            this.abandon();
          }
        }
      },
      (error: unknown) => {
        if (this.current !== request) {
          return;
        }
        this.current = {
          action: request.action,
          element: request.element,
          error,
          stale: isStaleChunkImportError(error),
          status: "error",
        };
        this.host.requestUpdate();
      },
    );
  }
}

export const COMMAND_PALETTE_ELEMENT = {
  tagName: "openclaw-command-palette",
  label: "command palette",
  loadModule: () => import("../components/command-palette.ts"),
} satisfies OptionalCustomElement;

const DEBUG_OVERLAY_TAG = "openclaw-debug-overlay";

export const DEBUG_OVERLAY_ELEMENT = {
  tagName: DEBUG_OVERLAY_TAG,
  label: DEBUG_OVERLAY_TAG,
  loadModule: () => import("../pages/debug/debug-overlay.ts"),
} satisfies OptionalCustomElement;

export const TERMINAL_PANEL_ELEMENT = {
  tagName: "openclaw-terminal-panel",
  label: "terminal panel",
  loadModule: () => import("../components/terminal/terminal-panel-registration.ts"),
} satisfies OptionalCustomElement;

export const BROWSER_PANEL_ELEMENT = {
  tagName: "openclaw-browser-panel",
  label: "browser panel",
  loadModule: () => import("../components/browser/browser-panel.ts"),
} satisfies OptionalCustomElement;

export const DESKTOP_PANEL_ELEMENT = {
  tagName: "openclaw-desktop-panel",
  label: "desktop panel",
  loadModule: () => import("../components/desktop/desktop-panel.ts"),
} satisfies OptionalCustomElement;

export const DASHBOARD_DOCUMENT_ELEMENT = {
  tagName: "openclaw-board-document",
  label: "dashboard document",
  loadModule: () => import("../components/board/board-document.ts"),
} satisfies OptionalCustomElement;

export const CUSTODIAN_PANEL_ELEMENT = {
  tagName: "openclaw-custodian-panel",
  label: "custodian panel",
  loadModule: () => import("../components/custodian/custodian-panel.ts"),
} satisfies OptionalCustomElement;

// Loaded only for approval document URLs: the approval page pulls the protocol
// validators (typebox runtime) and must stay out of the normal startup graph.
export const APPROVAL_PAGE_ELEMENT = {
  tagName: "openclaw-approval-page",
  label: "approval page",
  loadModule: () => import("../pages/approval/approval-page-registration.ts"),
} satisfies OptionalCustomElement;

// The card is in the chat graph, but modal-only queue controls stay off the
// startup path until an approval is actually pending.
const EXEC_APPROVAL_TAG = "openclaw-exec-approval";

export const EXEC_APPROVAL_ELEMENT = {
  tagName: EXEC_APPROVAL_TAG,
  // This diagnostic uses the tag rather than user-facing copy.
  label: EXEC_APPROVAL_TAG,
  loadModule: () => import("../components/exec-approval.ts"),
} satisfies OptionalCustomElement;

export function isOptionalElementDefined(element: OptionalCustomElement): boolean {
  return customElements.get(element.tagName) !== undefined;
}
