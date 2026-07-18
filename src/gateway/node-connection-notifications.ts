// Routes node connection alerts to the Mac most recently used by the operator.
import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { NodeRegistry, NodeSession } from "./node-registry.js";

type NotificationRegistry = Pick<NodeRegistry, "listConnected" | "invoke">;

type RouterOptions = {
  primaryDelayMs?: number;
  fallbackDelayMs?: number;
};

type PendingConnectionAlert = {
  nodeId: string;
  timer?: ReturnType<typeof setTimeout>;
};

const DEFAULT_PRIMARY_DELAY_MS = 750;
const DEFAULT_FALLBACK_DELAY_MS = 5_000;

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

/** One gateway-runtime router with short-lived first-connection timers. */
class NodeConnectionNotificationRouter {
  private readonly primaryDelayMs: number;
  private readonly fallbackDelayMs: number;
  private readonly pendingByNodeId = new Map<string, PendingConnectionAlert>();

  constructor(
    private readonly registry: NotificationRegistry,
    options: RouterOptions = {},
  ) {
    this.primaryDelayMs = options.primaryDelayMs ?? DEFAULT_PRIMARY_DELAY_MS;
    this.fallbackDelayMs = options.fallbackDelayMs ?? DEFAULT_FALLBACK_DELAY_MS;
  }

  onConnected(source: NodeSession, isFirstConnection: boolean): void {
    // A rapid replacement may take over an already-pending first-connection alert.
    // Ordinary reconnects have no pending claim and remain silent.
    if (!isFirstConnection && !this.pendingByNodeId.has(source.nodeId)) {
      return;
    }
    const previous = this.pendingByNodeId.get(source.nodeId);
    if (previous?.timer) {
      clearTimeout(previous.timer);
    }
    const pending: PendingConnectionAlert = { nodeId: source.nodeId };
    this.pendingByNodeId.set(source.nodeId, pending);
    this.armTimer(pending, this.primaryDelayMs, () => this.deliverPrimary(pending));
  }

  dispose(): void {
    for (const pending of this.pendingByNodeId.values()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
    }
    this.pendingByNodeId.clear();
  }

  private async deliverPrimary(pending: PendingConnectionAlert): Promise<void> {
    const source = this.currentSource(pending);
    if (!source) {
      this.finishAlert(pending);
      return;
    }
    const primary = this.notificationTargets()
      .filter((node) => node.lastActiveAtMs !== undefined)
      .toSorted(compareActivity)
      .at(0);
    const delivered = primary ? await this.notify(primary, source) : false;
    if (!this.attemptIsCurrent(pending)) {
      return;
    }
    if (delivered) {
      this.finishAlert(pending);
      return;
    }
    this.armTimer(pending, this.fallbackDelayMs, () =>
      this.deliverFallback(pending, primary?.connId),
    );
  }

  private async deliverFallback(
    pending: PendingConnectionAlert,
    attemptedConnId?: string,
  ): Promise<void> {
    const source = this.currentSource(pending);
    if (!source) {
      this.finishAlert(pending);
      return;
    }
    const targets = this.notificationTargets().filter((node) => node.connId !== attemptedConnId);
    await Promise.all(targets.map(async (node) => await this.notify(node, source)));
    if (this.attemptIsCurrent(pending)) {
      this.finishAlert(pending);
    }
  }

  private currentSource(pending: PendingConnectionAlert): NodeSession | undefined {
    if (!this.attemptIsCurrent(pending)) {
      return undefined;
    }
    return this.registry.listConnected().find((node) => node.nodeId === pending.nodeId);
  }

  private attemptIsCurrent(pending: PendingConnectionAlert): boolean {
    // Object identity lets a replacement invalidate both staged timers and
    // in-flight deliveries without a second generation bookkeeping path.
    return this.pendingByNodeId.get(pending.nodeId) === pending;
  }

  private finishAlert(pending: PendingConnectionAlert): void {
    if (this.attemptIsCurrent(pending)) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      this.pendingByNodeId.delete(pending.nodeId);
    }
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

  private armTimer(
    pending: PendingConnectionAlert,
    delayMs: number,
    deliver: () => Promise<void>,
  ): void {
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    pending.timer = setTimeout(() => {
      pending.timer = undefined;
      void deliver();
    }, delayMs);
  }
}

const routersByRegistry = new WeakMap<NodeRegistry, NodeConnectionNotificationRouter>();

/** Schedules a staged alert for one newly connected node. */
export function scheduleNodeConnectionNotification(
  registry: NodeRegistry,
  source: NodeSession,
  options: { isFirstConnection: boolean },
): void {
  let router = routersByRegistry.get(registry);
  if (!options.isFirstConnection && !router) {
    return;
  }
  if (!router) {
    router = new NodeConnectionNotificationRouter(registry);
    routersByRegistry.set(registry, router);
  }
  router.onConnected(source, options.isFirstConnection);
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
