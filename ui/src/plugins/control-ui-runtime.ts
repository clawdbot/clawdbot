import { CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS } from "../../../src/gateway/control-ui-plugin-frame-contract.js";
import type {
  ControlUiAction,
  ControlUiAccessory,
  ControlUiDisposer,
  ControlUiHost,
  ControlUiNavigationItem,
  ControlUiPage,
  ControlUiPanel,
  ControlUiPlugin,
  ControlUiReplacement,
  ControlUiSurface,
  ControlUiWidget,
} from "../../../src/plugin-sdk/control-ui.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { RouteId } from "../app-routes.ts";
import type { ApplicationContext } from "../app/context.ts";
import { readGatewayOperatorAccess } from "../app/operator-access.ts";
import { formatUiError } from "../lib/format-error.ts";
import { isGatewayMethodAdvertised } from "../lib/gateway-methods.ts";

type PluginAsset = {
  pluginId: string;
  name: string;
  revision: string;
  entryUrl: string;
  styles: string[];
};
type PluginCatalog = {
  revision: string;
  plugins: PluginAsset[];
  diagnostics: { pluginId: string; message: string }[];
};

export type ControlUiRegistration<T> = {
  key: `${string}/${string}`;
  pluginId: string;
  value: T;
  host: ControlUiHost;
  signal: AbortSignal;
};

type Contributions = {
  pages: ControlUiPage;
  navigation: ControlUiNavigationItem;
  panels: ControlUiPanel;
  actions: ControlUiAction;
  accessories: ControlUiAccessory;
  widgets: ControlUiWidget;
  replacements: ControlUiReplacement;
};

export type ControlUiPluginOwner = {
  descriptor: PluginAsset;
  client: GatewayBrowserClient;
  abort: AbortController;
  disposers: Set<ControlUiDisposer>;
  contributions: { [K in keyof Contributions]: Map<string, Contributions[K]> };
  selections: Map<ControlUiSurface, string | null>;
  host: ControlUiHost;
};

const CONTRIBUTION_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const ACTIVATION_TIMEOUT_MS = 15_000;

export class ControlUiPluginRuntime {
  private readonly owners = new Map<string, ControlUiPluginOwner>();
  private readonly selected = new Map<ControlUiSurface, string>();
  private readonly listeners = new Set<() => void>();
  private readonly loadingOwners = new Set<Omit<ControlUiPluginOwner, "host">>();
  private readonly stops: ControlUiDisposer[] = [];
  private client: GatewayBrowserClient | null = null;
  private hello: object | null = null;
  private refreshGeneration = 0;
  private disposed = false;
  private diagnostics: { pluginId: string; message: string }[] = [];
  private grantTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly getContext: () => ApplicationContext<RouteId>) {}

  get errors(): readonly { pluginId: string; message: string }[] {
    return this.diagnostics;
  }

  get hasPlugins(): boolean {
    return this.owners.size > 0 || this.loadingOwners.size > 0;
  }

  get canReload(): boolean {
    const snapshot = this.getContext().gateway.snapshot;
    return (
      !this.disposed &&
      snapshot.phase === "connected" &&
      readGatewayOperatorAccess(snapshot).canAdmin &&
      isGatewayMethodAdvertised(snapshot, "plugins.controlUi.reload") === true
    );
  }

  async reload(): Promise<void> {
    if (!this.canReload || !this.client) {
      throw new Error("Reloading plugin UI requires a connected operator with admin access.");
    }
    const client = this.client;
    const hello = this.hello;
    await client.request("plugins.controlUi.reload", {});
    if (this.disposed || this.client !== client || this.hello !== hello) {
      throw new Error("The connection changed while reloading plugin UI. Reconnect and retry.");
    }
    await this.refresh();
  }

  subscribe(listener: () => void): ControlUiDisposer {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  invalidate(owner: Omit<ControlUiPluginOwner, "host">): void {
    if (!this.isCurrent(owner)) {
      throw new Error("This plugin UI activation has ended.");
    }
    this.publish();
  }

  start(): void {
    const context = this.getContext();
    this.stops.push(
      context.gateway.subscribe(() => this.syncConnection()),
      context.gateway.subscribeEvents((event) => {
        if (event.event === "plugins.controlUi.changed") {
          void this.refresh();
        }
      }),
    );
    this.syncConnection();
  }

  private syncConnection(): void {
    const snapshot = this.getContext().gateway.snapshot;
    const client = snapshot.phase === "connected" ? snapshot.client : null;
    const hello = client ? snapshot.hello : null;
    if (this.client === client && this.hello === hello) {
      return;
    }
    this.retireOwners();
    this.client = client;
    this.hello = hello;
    this.diagnostics = [];
    this.publish();
    if (client && isGatewayMethodAdvertised(snapshot, "plugins.controlUi.list")) {
      void this.refresh();
    }
  }

  async refresh(): Promise<void> {
    const client = this.client;
    if (!client || this.disposed) {
      return;
    }
    const generation = ++this.refreshGeneration;
    // Explicit reload supersedes pending activation even when a plugin's async
    // initializer never settles; retained host closures are revoked immediately.
    for (const owner of this.loadingOwners) {
      this.disposeOwner(owner);
    }
    this.loadingOwners.clear();
    const current = () =>
      !this.disposed && this.client === client && this.refreshGeneration === generation;
    const load = async () => {
      try {
        const catalog = await client.request<PluginCatalog>("plugins.controlUi.list", {});
        if (!current()) {
          return;
        }
        this.diagnostics = catalog.diagnostics;
        const installed = new Set(catalog.plugins.map((plugin) => plugin.pluginId));
        for (const [id, owner] of this.owners) {
          if (!installed.has(id)) {
            this.owners.delete(id);
            this.disposeOwner(owner);
          }
        }
        this.publish();
        const granted = new Set<string>();
        if (catalog.plugins.length) {
          const gatewayUrl = new URL(client.gatewayUrl, window.location.href);
          if (gatewayUrl.protocol === "ws:") {
            gatewayUrl.protocol = "http:";
          }
          if (gatewayUrl.protocol === "wss:") {
            gatewayUrl.protocol = "https:";
          }
          if (gatewayUrl.origin !== window.location.origin) {
            const error = new Error(
              `Native plugin UI requires the Control UI served by the connected Gateway. Open ${gatewayUrl.origin} and reconnect there.`,
            );
            await Promise.all(
              catalog.plugins.map((descriptor) => {
                this.reportError(descriptor.pluginId, error);
                return this.reportActivation(descriptor, client, current, "failed", error);
              }),
            );
            return;
          }
          const bootstrap = await this.getContext().config.refresh();
          if (!current()) {
            return;
          }
          if (!bootstrap) {
            throw new Error("Could not authenticate native plugin assets. Reconnect and retry.");
          }
          for (const descriptor of catalog.plugins) {
            const prefix = `/__openclaw__/plugins/control-ui/${encodeURIComponent(descriptor.pluginId)}/`;
            if (
              !bootstrap.pluginAssetsRequireAuth ||
              bootstrap.pluginFrameGrants.some(
                (grant) =>
                  grant.pluginId === descriptor.pluginId &&
                  grant.match === "prefix" &&
                  grant.path === prefix,
              )
            ) {
              granted.add(descriptor.pluginId);
            } else {
              const error = new Error(
                `Native plugin asset grant unavailable: ${descriptor.pluginId}`,
              );
              this.reportError(descriptor.pluginId, error);
              await this.reportActivation(descriptor, client, current, "failed", error);
            }
          }
          if (bootstrap.pluginAssetsRequireAuth) {
            this.startGrantRenewal();
          }
        }
        // Each plugin owns its deadline. A slow initializer must not prevent
        // unrelated plugins from becoming available or keep Reload pending.
        await Promise.all(
          catalog.plugins
            .filter(
              (descriptor) =>
                granted.has(descriptor.pluginId) &&
                this.owners.get(descriptor.pluginId)?.descriptor.revision !== descriptor.revision,
            )
            .map((descriptor) => this.activate(descriptor, client, current)),
        );
        this.publish();
      } catch (error) {
        if (current()) {
          this.reportError("host", error);
        }
      }
    };
    await load();
  }

  private startGrantRenewal(): void {
    if (this.grantTimer !== null) {
      return;
    }
    this.grantTimer = setInterval(() => {
      if (this.client && this.owners.size) {
        void this.getContext()
          .config.refresh()
          .catch((error: unknown) => this.reportError("host", error));
      }
    }, CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS / 2);
  }

  private async activate(
    descriptor: PluginAsset,
    client: GatewayBrowserClient,
    current: () => boolean,
  ) {
    const abort = new AbortController();
    const owner: Omit<ControlUiPluginOwner, "host"> = {
      descriptor,
      client,
      abort,
      disposers: new Set<ControlUiDisposer>(),
      contributions: {
        pages: new Map(),
        navigation: new Map(),
        panels: new Map(),
        actions: new Map(),
        replacements: new Map(),
        accessories: new Map(),
        widgets: new Map(),
      },
      selections: new Map<ControlUiSurface, string | null>(),
    };
    this.loadingOwners.add(owner);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const styles: HTMLLinkElement[] = [];
      const initialize = async (): Promise<ControlUiPluginOwner | undefined> => {
        const { createControlUiPluginHost } = await import("./control-ui-host.ts");
        if (!current() || abort.signal.aborted) {
          return undefined;
        }
        const complete: ControlUiPluginOwner = Object.assign(owner, {
          host: createControlUiPluginHost(this.getContext, this, owner),
        });
        const url = this.assetUrl(descriptor, descriptor.entryUrl);
        for (const path of descriptor.styles) {
          const link = document.createElement("link");
          link.rel = "stylesheet";
          link.media = "not all";
          link.href = this.assetUrl(descriptor, path);
          const loaded = new Promise<void>((resolve, reject) => {
            link.addEventListener("load", () => resolve(), { once: true, signal: abort.signal });
            link.addEventListener(
              "error",
              () => reject(new Error(`Could not load plugin stylesheet: ${descriptor.pluginId}`)),
              { once: true, signal: abort.signal },
            );
            abort.signal.addEventListener(
              "abort",
              () => reject(new Error("Plugin UI activation ended.")),
              { once: true },
            );
          });
          document.head.append(link);
          complete.disposers.add(() => link.remove());
          styles.push(link);
          await loaded;
        }
        const module: { default?: ControlUiPlugin } = await import(/* @vite-ignore */ url);
        if (!current() || abort.signal.aborted) {
          this.disposeOwner(complete);
          return undefined;
        }
        if (
          module.default?.id !== descriptor.pluginId ||
          typeof module.default.activate !== "function"
        ) {
          throw new Error(
            "Native UI entry must export its matching defineControlUiPlugin definition.",
          );
        }
        const stop = await module.default.activate(complete.host);
        if (stop) {
          complete.disposers.add(stop);
        }
        if (!current() || abort.signal.aborted) {
          this.disposeOwner(complete);
          return undefined;
        }
        return complete;
      };
      const complete = await Promise.race([
        initialize(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  "Plugin UI initialization timed out. Check the plugin and reload its UI.",
                ),
              ),
            ACTIVATION_TIMEOUT_MS,
          );
          abort.signal.addEventListener(
            "abort",
            () => reject(new Error("Plugin UI activation ended.")),
            { once: true },
          );
        }),
      ]);
      if (!complete || !current() || abort.signal.aborted) {
        this.disposeOwner(owner);
        return;
      }
      const previous = this.owners.get(descriptor.pluginId);
      // The receipt is asynchronous, but publication completes activation.
      // A concurrent catalog refresh may revoke only owners still initializing.
      this.loadingOwners.delete(owner);
      this.owners.set(descriptor.pluginId, complete);
      for (const link of styles) {
        link.media = "all";
      }
      if (previous) {
        this.disposeOwner(previous);
      }
      for (const [surface, id] of complete.selections) {
        this.selectReplacement(surface, id === null ? null : `${descriptor.pluginId}/${id}`);
      }
      this.publish();
      await this.reportActivation(descriptor, client, current, "activated");
    } catch (error) {
      this.disposeOwner(owner);
      if (current()) {
        this.reportError(descriptor.pluginId, error);
        await this.reportActivation(descriptor, client, current, "failed", error);
      }
    } finally {
      clearTimeout(timer);
      this.loadingOwners.delete(owner);
    }
  }

  private async reportActivation(
    descriptor: PluginAsset,
    client: GatewayBrowserClient,
    current: () => boolean,
    status: "activated" | "failed",
    error?: unknown,
  ): Promise<void> {
    if (!current()) {
      return;
    }
    try {
      await client.request("plugins.controlUi.report", {
        pluginId: descriptor.pluginId,
        revision: descriptor.revision,
        status,
        ...(error === undefined
          ? {}
          : { error: formatUiError(error, "Plugin UI activation failed.").slice(0, 512) }),
      });
    } catch (failure) {
      if (current()) {
        this.reportError(descriptor.pluginId, failure);
      }
    }
  }

  private assetUrl(descriptor: PluginAsset, path: string): string {
    const url = new URL(path, window.location.href);
    const prefix = `/__openclaw__/plugins/control-ui/${encodeURIComponent(descriptor.pluginId)}/${encodeURIComponent(descriptor.revision)}/`;
    if (url.origin !== window.location.origin || !url.pathname.startsWith(prefix)) {
      throw new Error("Native plugin assets must be served by this Control UI Gateway.");
    }
    return url.href;
  }

  isCurrent(owner: Omit<ControlUiPluginOwner, "host">): boolean {
    return !this.disposed && !owner.abort.signal.aborted && this.client === owner.client;
  }

  register<K extends keyof Contributions>(
    owner: Omit<ControlUiPluginOwner, "host">,
    kind: K,
    value: Contributions[K],
  ): ControlUiDisposer {
    if (!this.isCurrent(owner)) {
      throw new Error("This plugin UI activation has ended.");
    }
    const entries = owner.contributions[kind];
    if (!CONTRIBUTION_ID.test(value.id) || entries.has(value.id)) {
      throw new Error(`Invalid or duplicate plugin UI contribution: ${value.id}`);
    }
    entries.set(value.id, value);
    this.publish();
    const dispose = () => {
      owner.disposers.delete(dispose);
      if (entries.get(value.id) === value) {
        entries.delete(value.id);
        this.publish();
      }
    };
    owner.disposers.add(dispose);
    return dispose;
  }

  registrations<K extends keyof Contributions>(kind: K): ControlUiRegistration<Contributions[K]>[] {
    const values: ControlUiRegistration<Contributions[K]>[] = [];
    for (const owner of this.owners.values()) {
      for (const [id, value] of owner.contributions[kind]) {
        values.push({
          key: `${owner.descriptor.pluginId}/${id}`,
          pluginId: owner.descriptor.pluginId,
          value,
          host: owner.host,
          signal: owner.abort.signal,
        });
      }
    }
    return values.toSorted((a, b) => a.key.localeCompare(b.key));
  }

  selectedReplacement(
    surface: ControlUiSurface,
  ): ControlUiRegistration<ControlUiReplacement> | undefined {
    const selected = this.selected.get(surface);
    return this.registrations("replacements").find(
      (entry) => entry.key === selected && entry.value.surface === surface,
    );
  }

  selectReplacement(surface: ControlUiSurface, key: string | null): void {
    if (
      key !== null &&
      !this.registrations("replacements").some(
        (entry) => entry.key === key && entry.value.surface === surface,
      )
    ) {
      throw new Error("The selected UI replacement is unavailable.");
    }
    if (key === null) {
      this.selected.delete(surface);
    } else {
      this.selected.set(surface, key);
    }
    this.publish();
  }

  reportError(pluginId: string, error: unknown): void {
    const message = formatUiError(error, "Plugin UI failed.");
    if (
      this.diagnostics.some((entry) => entry.pluginId === pluginId && entry.message === message)
    ) {
      return;
    }
    this.diagnostics = [
      ...this.diagnostics.filter((entry) => entry.pluginId !== pluginId),
      {
        pluginId,
        message,
      },
    ].slice(-20);
    this.publish();
  }

  private publish(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private disposeOwner(owner: Omit<ControlUiPluginOwner, "host">): void {
    owner.abort.abort();
    for (const dispose of [...owner.disposers].toReversed()) {
      try {
        dispose();
      } catch (error) {
        this.reportError(owner.descriptor.pluginId, error);
      }
    }
    owner.disposers.clear();
  }

  private retireOwners(): void {
    this.refreshGeneration += 1;
    if (this.grantTimer !== null) {
      clearInterval(this.grantTimer);
      this.grantTimer = null;
    }
    const owners = [...this.owners.values(), ...this.loadingOwners];
    this.owners.clear();
    this.loadingOwners.clear();
    for (const owner of owners) {
      this.disposeOwner(owner);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.retireOwners();
    for (const stop of this.stops) {
      stop();
    }
    this.stops.length = 0;
    this.listeners.clear();
  }
}
