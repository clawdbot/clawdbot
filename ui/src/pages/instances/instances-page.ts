import { consume } from "@lit/context";
import { html } from "lit";
import { state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { PresenceEntry } from "../../api/types.ts";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "../../lib/gateway-errors.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { renderInstances } from "./view.ts";

function readPresence(value: unknown): PresenceEntry[] | null {
  const presence =
    value && typeof value === "object" ? (value as { presence?: unknown }).presence : null;
  return Array.isArray(presence) ? (presence as PresenceEntry[]) : null;
}

class InstancesPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private loading = false;
  @state() private entries: PresenceEntry[] = [];
  @state() private error: string | null = null;
  @state() private status: string | null = null;
  @state() private hostsRevealed = false;

  private client: GatewayBrowserClient | null = null;
  private connected = false;
  private requestId = 0;
  private gatewaySource?: ApplicationContext["gateway"];
  private readonly subscriptions = new SubscriptionsController(this).effect(
    () => this.context?.gateway,
    (gateway) => {
      const sourceChanged = this.gatewaySource !== undefined && this.gatewaySource !== gateway;
      this.gatewaySource = gateway;
      const stopEvents = gateway.subscribeEvents((event) => {
        if (this.gatewaySource !== gateway) {
          return;
        }
        const presence = event.event === "presence" ? readPresence(event.payload) : null;
        if (presence) {
          this.applyPresence(presence);
        }
      });
      const stopGateway = gateway.subscribe((snapshot) => {
        if (this.gatewaySource === gateway) {
          this.applyGatewaySnapshot(snapshot);
        }
      });
      this.applyGatewaySnapshot(gateway.snapshot, sourceChanged);
      return () => {
        stopEvents();
        stopGateway();
      };
    },
  );

  override disconnectedCallback() {
    this.subscriptions.clear();
    this.invalidateRequest();
    this.client = null;
    this.connected = false;
    this.hostsRevealed = false;
    super.disconnectedCallback();
  }

  private applyGatewaySnapshot(snapshot: ApplicationGatewaySnapshot, sourceChanged = false) {
    const clientChanged = sourceChanged || snapshot.client !== this.client;
    const connectionChanged = snapshot.connected !== this.connected;
    const becameConnected = snapshot.connected && !this.connected;
    this.client = snapshot.client;
    this.connected = snapshot.connected;

    if (clientChanged || connectionChanged) {
      this.hostsRevealed = false;
    }
    if (clientChanged) {
      this.invalidateRequest();
      this.entries = [];
      this.error = null;
      this.status = null;
    }
    if (!snapshot.connected || !snapshot.client) {
      this.invalidateRequest();
      return;
    }
    if (!clientChanged && !becameConnected) {
      return;
    }

    const initialPresence = readPresence(snapshot.hello?.snapshot);
    if (initialPresence) {
      this.applyPresence(initialPresence);
    }
    void this.loadPresence();
  }

  private applyPresence(entries: PresenceEntry[]) {
    this.invalidateRequest();
    this.entries = entries;
    this.error = null;
    this.status = entries.length === 0 ? "No instances yet." : null;
  }

  private invalidateRequest() {
    this.requestId += 1;
    this.loading = false;
  }

  private isCurrentRequest(requestId: number, client: GatewayBrowserClient): boolean {
    const gateway = this.context.gateway.snapshot;
    return this.isConnected && requestId === this.requestId && gateway.client === client;
  }

  private async loadPresence() {
    const gateway = this.context.gateway.snapshot;
    const client = gateway.client;
    if (!gateway.connected || !client || this.loading) {
      return;
    }

    const requestId = ++this.requestId;
    this.loading = true;
    this.error = null;
    this.status = null;
    try {
      const response = await client.request("system-presence", {});
      if (!this.isCurrentRequest(requestId, client)) {
        return;
      }
      if (Array.isArray(response)) {
        this.entries = response as PresenceEntry[];
        this.status = response.length === 0 ? "No instances yet." : null;
      } else {
        this.entries = [];
        this.status = "No presence payload.";
      }
    } catch (error) {
      if (!this.isCurrentRequest(requestId, client)) {
        return;
      }
      if (isMissingOperatorReadScopeError(error)) {
        this.entries = [];
        this.status = null;
        this.error = formatMissingOperatorReadScopeMessage("instance presence");
      } else {
        this.error = String(error);
      }
    } finally {
      if (this.isCurrentRequest(requestId, client)) {
        this.loading = false;
      }
    }
  }

  override render() {
    return html`
      <section class="content-header content-header--page">
        <div>
          <div class="page-title">${titleForRoute("instances")}</div>
          <div class="page-sub">${subtitleForRoute("instances")}</div>
        </div>
      </section>
      ${renderInstances({
        loading: this.loading,
        entries: this.entries,
        lastError: this.error,
        statusMessage: this.status,
        hostsRevealed: this.hostsRevealed,
        onRefresh: () => void this.loadPresence(),
        onToggleHosts: () => {
          this.hostsRevealed = !this.hostsRevealed;
        },
      })}
    `;
  }
}

customElements.define("openclaw-instances-page", InstancesPage);
