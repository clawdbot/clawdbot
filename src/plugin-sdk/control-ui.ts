/** Browser-only contract for trusted native Control UI plugins. No host implementation imports. */
import type { AgentSummary, SessionRow } from "@openclaw/gateway-protocol";
import type { ControlUiComponents } from "./control-ui-components.js";
export type {
  ControlUiAgentPickerProps,
  ControlUiComponentHandle,
  ControlUiComponents,
  ControlUiDashboardProps,
  ControlUiDialogProps,
} from "./control-ui-components.js";
export type ControlUiDisposer = () => void;

export type ControlUiConnection = {
  connected: boolean;
  canRead: boolean;
  canWrite: boolean;
  canGrant: boolean;
  canAdmin: boolean;
  assistantAgentId: string | null;
};

export type ControlUiSession = Readonly<SessionRow>;

export type ControlUiAgent = Readonly<AgentSummary>;
export type ControlUiPageTarget = {
  id: string;
  params?: Readonly<Record<string, string>>;
  /** Unescaped path segments for a page with an advertised native route placement. */
  path?: readonly string[];
};
export type ControlUiPageNavigationOptions = {
  /** Replace the current history entry when canonicalizing a page or changing its filters. */
  replace?: boolean;
  /** Retain the current query, with target parameters taking precedence. */
  preserveSearch?: boolean;
};

export type ControlUiSurfaceProps = {
  "session-list": { sessionKey: string; sessions: readonly ControlUiSession[] };
  composer: {
    sessionKey: string;
    agentId: string;
    draft: string;
    canSend: boolean;
    sending: boolean;
    disabledReason: string | null;
    setDraft: (text: string) => void;
    /** Resolves true on admission, false on rejection, or void for a local command/no submit. */
    send: () => Promise<boolean | void>;
    abort?: () => void;
  };
  workspace: { sessionKey: string; routeId: string };
  transcript: {
    sessionKey: string;
    messages: readonly unknown[];
    stream: string | null;
    loading: boolean;
  };
  "tool-result": {
    sessionKey: string;
    toolName: string;
    toolCallId: string;
    input: unknown;
    output: unknown;
    expanded: boolean;
  };
};

export type ControlUiSurface = keyof ControlUiSurfaceProps;

export type ControlUiViewContext<T = Readonly<Record<string, string>>> = {
  readonly host: ControlUiHost;
  readonly signal: AbortSignal;
  readonly props: T;
  readonly presented: boolean;
  /** Mount the host's built-in view inside a replacement; it keeps receiving host updates. */
  mountDefault: (container: HTMLElement) => ControlUiDisposer;
};

export type ControlUiView<T = Readonly<Record<string, string>>> = (
  container: HTMLElement,
  context: ControlUiViewContext<T>,
) => {
  update?: (context: ControlUiViewContext<T>) => void;
  focus?: () => void;
  dispose?: ControlUiDisposer;
} | void;

export type ControlUiPage = {
  id: string;
  label: string;
  mount: ControlUiView;
};

export type ControlUiNavigationItem = {
  id: string;
  label: string;
  page: ControlUiPageTarget;
  icon?: string;
  order?: number;
  /** False offers the destination in the pin editor without adding it to the sidebar. */
  defaultVisible?: boolean;
};

export type ControlUiPanel = {
  id: string;
  label: string;
  mount: ControlUiView<{ sessionKey: string }>;
};

export type ControlUiAction = {
  id: string;
  label: string;
  placement: "composer" | "header" | "session";
  resolve?: (context: { sessionKey: string; session?: ControlUiSession }) => {
    label?: string;
    disabled?: boolean;
    hidden?: boolean;
  };
  run: (context: {
    sessionKey: string;
    session?: ControlUiSession;
    host: ControlUiHost;
    signal: AbortSignal;
  }) => void | Promise<void>;
};

export type ControlUiAccessory = {
  id: string;
  placement: "session-header";
  mount: ControlUiView<{ sessionKey: string }>;
};

export type ControlUiWidget = {
  id: string;
  label: string;
  mount: ControlUiView<{
    sessionKey: string;
    widget: { name: string; props?: Readonly<Record<string, unknown>> };
    canMutate: boolean;
    canGrant: boolean;
  }>;
};

export type ControlUiReplacement<S extends ControlUiSurface = ControlUiSurface> = {
  [Surface in S]: {
    id: string;
    label: string;
    surface: Surface;
    mount: ControlUiView<ControlUiSurfaceProps[Surface]>;
  };
}[S];

export type ControlUiHost = {
  readonly apiVersion: 1;
  readonly pluginId: string;
  readonly signal: AbortSignal;
  readonly basePath: string;
  readonly locale: string;
  redact: (text: string) => string;
  readonly connection: ControlUiConnection;
  readonly components: ControlUiComponents;
  /** Requests use the current authenticated connection; the Gateway still enforces its scopes. */
  request: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;
  onEvent: (event: string, listener: (payload: unknown) => void) => ControlUiDisposer;
  subscribe: (listener: () => void) => ControlUiDisposer;
  sessions: {
    readonly rows: readonly ControlUiSession[];
    readonly selectedKey: string;
    normalizeKey: (sessionKey: string) => string;
    refresh: () => Promise<void>;
    open: (sessionKey: string) => void;
    create: (params?: { agentId?: string; label?: string }) => Promise<string | null>;
    patch: (sessionKey: string, patch: { label?: string; model?: string | null }) => Promise<void>;
  };
  agents: {
    readonly rows: readonly ControlUiAgent[];
    readonly selectedId: string | null;
    readonly defaultId: string | null;
    readonly scopeId: string | null;
    select: (agentId: string) => void;
    setScope: (agentId: string | null) => void;
    refresh: () => Promise<void>;
  };
  navigation: {
    openPage: (target: ControlUiPageTarget, options?: ControlUiPageNavigationOptions) => void;
    pageHref: (
      target: ControlUiPageTarget,
      options?: Pick<ControlUiPageNavigationOptions, "preserveSearch">,
    ) => string;
  };
  ui: {
    /** Refresh contributions whose presentation depends on plugin-owned state. */
    invalidate: () => void;
    registerPage: (page: ControlUiPage) => ControlUiDisposer;
    registerNavigation: (item: ControlUiNavigationItem) => ControlUiDisposer;
    registerPanel: (panel: ControlUiPanel) => ControlUiDisposer;
    registerAction: (action: ControlUiAction) => ControlUiDisposer;
    registerAccessory: (accessory: ControlUiAccessory) => ControlUiDisposer;
    registerWidget: (widget: ControlUiWidget) => ControlUiDisposer;
    registerReplacement: (replacement: ControlUiReplacement) => ControlUiDisposer;
    /** Select an owned replacement, or restore the built-in view for this surface. */
    selectReplacement: (surface: ControlUiSurface, id: string | null) => void;
  };
};

export type ControlUiPlugin = {
  id: string;
  activate: (host: ControlUiHost) => void | ControlUiDisposer | Promise<void | ControlUiDisposer>;
};

export function defineControlUiPlugin(plugin: ControlUiPlugin): ControlUiPlugin {
  return plugin;
}
