// Routes node connection alerts to the Mac most recently used by the operator.
import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { NodeRegistry, NodeSession } from "./node-registry.js";

type NotificationRegistry = Pick<NodeRegistry, "listConnected" | "invoke">;

type RouterOptions = {
  primaryDelayMs?: number;
  fallbackDelayMs?: number;
  reconnectCooldownMs?: number;
  now?: () => number;
};

const DEFAULT_PRIMARY_DELAY_MS = 750;
const DEFAULT_FALLBACK_DELAY_MS = 5_000;
const DEFAULT_RECONNECT_COOLDOWN_MS = 5 * 60_000;

function isMacNotificationNode(node: NodeSession): boolean {
  const platform = node.platform?.trim().toLowerCase() ?? "";
  return (
    (platform === "darwin" || platform.startsWith("macos")) &&
    node.commands.includes("system.notify")
  );
}

function compareActivity(left: NodeSession, right: NodeSession): number {
  const activeDelta = (right.lastActiveAtMs ?? -1) - (left.lastActiveAtMs ?? -1);
  if (activeDelta !== 0) {
    return activeDelta;
  }
  return (right.presenceUpdatedAtMs ?? -1) - (left.presenceUpdatedAtMs ?? -1);
}

function connectionLabel(node: NodeSession): string {
  const raw = normalizeOptionalString(node.displayName) ?? node.nodeId;
  return sliceUtf16Safe(raw.replace(/\s+/g, " "), 0, 80);
}

/** One gateway-runtime router with bounded reconnect suppression and short-lived timers. */
class NodeConnectionNotificationRouter {
  private readonly primaryDelayMs: number;
  private readonly fallbackDelayMs: number;
  private readonly reconnectCooldownMs: number;
  private readonly now: () => number;
  private readonly lastAlertAtByNodeId = new Map<string, number>();
  private readonly timersByNodeId = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pendingConnByNodeId = new Map<string, string>();

  constructor(
    private readonly registry: NotificationRegistry,
    options: RouterOptions = {},
  ) {
    this.primaryDelayMs = options.primaryDelayMs ?? DEFAULT_PRIMARY_DELAY_MS;
    this.fallbackDelayMs = options.fallbackDelayMs ?? DEFAULT_FALLBACK_DELAY_MS;
    this.reconnectCooldownMs = options.reconnectCooldownMs ?? DEFAULT_RECONNECT_COOLDOWN_MS;
    this.now = options.now ?? Date.now;
  }

  onConnected(source: NodeSession): void {
    const now = this.now();
    const previous = this.lastAlertAtByNodeId.get(source.nodeId);
    if (previous !== undefined && now - previous < this.reconnectCooldownMs) {
      return;
    }
    this.pendingConnByNodeId.set(source.nodeId, source.connId);
    this.replaceTimer(
      source.nodeId,
      setTimeout(() => {
        this.timersByNodeId.delete(source.nodeId);
        void this.deliverPrimary(source);
      }, this.primaryDelayMs),
    );
  }

  dispose(): void {
    for (const timer of this.timersByNodeId.values()) {
      clearTimeout(timer);
    }
    this.timersByNodeId.clear();
    this.pendingConnByNodeId.clear();
  }

  private async deliverPrimary(source: NodeSession): Promise<void> {
    if (!this.attemptIsCurrent(source)) {
      return;
    }
    const primary = this.notificationTargets()
      .filter((node) => node.lastActiveAtMs !== undefined)
      .toSorted(compareActivity)
      .at(0);
    const delivered = primary ? await this.notify(primary, source) : false;
    if (!this.attemptIsCurrent(source)) {
      return;
    }
    if (delivered) {
      this.finishAlert(source);
      return;
    }
    this.replaceTimer(
      source.nodeId,
      setTimeout(() => {
        this.timersByNodeId.delete(source.nodeId);
        void this.deliverFallback(source, primary?.connId);
      }, this.fallbackDelayMs),
    );
  }

  private async deliverFallback(source: NodeSession, attemptedConnId?: string): Promise<void> {
    if (!this.attemptIsCurrent(source)) {
      return;
    }
    const targets = this.notificationTargets().filter((node) => node.connId !== attemptedConnId);
    await Promise.all(targets.map(async (node) => await this.notify(node, source)));
    if (this.attemptIsCurrent(source)) {
      this.finishAlert(source);
    }
  }

  private attemptIsCurrent(source: NodeSession): boolean {
    return (
      this.pendingConnByNodeId.get(source.nodeId) === source.connId &&
      this.registry
        .listConnected()
        .some((node) => node.nodeId === source.nodeId && node.connId === source.connId)
    );
  }

  private finishAlert(source: NodeSession): void {
    this.pendingConnByNodeId.delete(source.nodeId);
    const now = this.now();
    this.lastAlertAtByNodeId.set(source.nodeId, now);
    this.pruneCooldowns(now);
  }

  private notificationTargets(): NodeSession[] {
    return this.registry.listConnected().filter(isMacNotificationNode);
  }

  private async notify(target: NodeSession, source: NodeSession): Promise<boolean> {
    try {
      const result = await this.registry.invoke({
        nodeId: target.nodeId,
        expectedConnId: target.connId,
        command: "system.notify",
        params: {
          title: "Node connected",
          body: `${connectionLabel(source)} connected to OpenClaw.`,
          priority: "active",
          delivery: "auto",
        },
        timeoutMs: 10_000,
        idempotencyKey: randomUUID(),
      });
      return result.ok;
    } catch {
      return false;
    }
  }

  private replaceTimer(nodeId: string, timer: ReturnType<typeof setTimeout>): void {
    const existing = this.timersByNodeId.get(nodeId);
    if (existing) {
      clearTimeout(existing);
    }
    this.timersByNodeId.set(nodeId, timer);
  }

  private pruneCooldowns(now: number): void {
    if (this.lastAlertAtByNodeId.size <= 256) {
      return;
    }
    for (const [nodeId, alertedAt] of this.lastAlertAtByNodeId) {
      if (now - alertedAt >= this.reconnectCooldownMs) {
        this.lastAlertAtByNodeId.delete(nodeId);
      }
      if (this.lastAlertAtByNodeId.size <= 256) {
        return;
      }
    }
    while (this.lastAlertAtByNodeId.size > 256) {
      const oldest = this.lastAlertAtByNodeId.keys().next().value;
      if (oldest === undefined) {
        return;
      }
      this.lastAlertAtByNodeId.delete(oldest);
    }
  }
}

const routersByRegistry = new WeakMap<NodeRegistry, NodeConnectionNotificationRouter>();

/** Schedules a staged alert for one newly connected node. */
export function scheduleNodeConnectionNotification(
  registry: NodeRegistry,
  source: NodeSession,
): void {
  let router = routersByRegistry.get(registry);
  if (!router) {
    router = new NodeConnectionNotificationRouter(registry);
    routersByRegistry.set(registry, router);
  }
  router.onConnected(source);
}

/** Cancels staged alerts owned by a gateway node registry during shutdown. */
export function disposeNodeConnectionNotifications(registry: NodeRegistry): void {
  const router = routersByRegistry.get(registry);
  if (!router) {
    return;
  }
  router.dispose();
  routersByRegistry.delete(registry);
}
