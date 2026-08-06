import type { ReactiveControllerHost } from "lit";

type McpAppUnmountTarget = Element & {
  restartAfterTeardown(): void;
  teardown(): Promise<void>;
};

function isMcpAppUnmountTarget(value: Element): value is McpAppUnmountTarget {
  return (
    typeof Reflect.get(value, "restartAfterTeardown") === "function" &&
    typeof Reflect.get(value, "teardown") === "function"
  );
}

function findMcpAppUnmountTargets(
  roots: Iterable<ParentNode>,
  selector = "mcp-app-view",
): McpAppUnmountTarget[] {
  const targets = new Set<McpAppUnmountTarget>();
  for (const root of roots) {
    if (root instanceof Element && root.matches(selector) && isMcpAppUnmountTarget(root)) {
      targets.add(root);
    }
    for (const candidate of root.querySelectorAll(selector)) {
      if (isMcpAppUnmountTarget(candidate)) {
        targets.add(candidate);
      }
    }
  }
  return [...targets];
}

/**
 * Keeps the currently rendered subtree connected while MCP Apps acknowledge teardown.
 * New renders coalesce behind one bounded component-owned teardown instead of queuing.
 */
export class McpAppUnmountGate {
  private renderedKey: string | null = null;
  private renderedValue: unknown;
  private pending = false;
  private restartTargets: McpAppUnmountTarget[] | null = null;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly selector = "mcp-app-view",
  ) {}

  private apply(key: string, value: unknown): unknown {
    this.renderedKey = key;
    this.renderedValue = value;
    return this.renderedValue;
  }

  render(key: string, value: unknown, leavingRoots: () => Iterable<ParentNode>): unknown {
    if (this.pending) {
      return this.renderedValue;
    }
    if (this.restartTargets) {
      const targets = this.restartTargets;
      this.restartTargets = null;
      // Lit commits the parent update synchronously after render. Restart only
      // torn-down views that survived that commit; retained siblings stay intact.
      queueMicrotask(() => {
        for (const target of targets) {
          if (target.isConnected) {
            target.restartAfterTeardown();
          }
        }
      });
      return this.apply(key, value);
    }
    if (this.renderedKey === null || this.renderedKey === key) {
      return this.apply(key, value);
    }

    const targets = findMcpAppUnmountTargets(leavingRoots(), this.selector);
    if (targets.length === 0) {
      return this.apply(key, value);
    }

    this.pending = true;
    void Promise.allSettled(targets.map((target) => target.teardown())).then(() => {
      this.pending = false;
      this.restartTargets = targets;
      this.host.requestUpdate();
    });
    return this.renderedValue;
  }
}
