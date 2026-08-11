import type { GatewayBrowserClient } from "../api/gateway.ts";
import { formatUiError } from "../lib/format-error.ts";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";
import { hasOperatorAdminAccess } from "./operator-access.ts";

export type ScopeUpgradeState =
  | { phase: "hidden" }
  | { phase: "available" }
  | { phase: "requesting" }
  | { phase: "pending"; requestId: string }
  | { phase: "rejected"; requestId: string; expired: boolean }
  | { phase: "error"; message: string };

type UpgradeOperation = {
  client: GatewayBrowserClient;
  generation: number;
};

function isLimitedConnection(snapshot: ApplicationGatewaySnapshot): boolean {
  const auth = snapshot.hello?.auth;
  return (
    snapshot.phase === "connected" && auth?.scopes !== undefined && !hasOperatorAdminAccess(auth)
  );
}

/** Owns the explicit live scope-upgrade action and its cross-route banner state. */
export class ScopeUpgradeController {
  private current: ApplicationGatewaySnapshot;
  private operation: UpgradeOperation | null = null;
  private generation = 0;
  private value: ScopeUpgradeState = { phase: "hidden" };

  constructor(
    initial: ApplicationGatewaySnapshot,
    private readonly onChange: () => void,
  ) {
    this.current = initial;
    this.sync(initial);
  }

  get state(): ScopeUpgradeState {
    return this.value;
  }

  sync(snapshot: ApplicationGatewaySnapshot): void {
    this.current = snapshot;
    const client = snapshot.client;
    if (!client || !isLimitedConnection(snapshot)) {
      this.retireOperation();
      this.setState({ phase: "hidden" });
      return;
    }
    if (this.operation && this.operation.client !== client) {
      this.retireOperation();
    }
    if (this.value.phase === "hidden") {
      this.setState({ phase: "available" });
    }
  }

  request(): void {
    this.start(false);
  }

  retry(): void {
    this.start(true);
  }

  cancel(): void {
    this.retireOperation();
    this.setState(isLimitedConnection(this.current) ? { phase: "available" } : { phase: "hidden" });
  }

  dispose(): void {
    this.retireOperation();
  }

  private start(retry: boolean): void {
    const client = this.current.client;
    if (!client || !isLimitedConnection(this.current)) {
      return;
    }
    if (this.operation) {
      if (!retry) {
        return;
      }
      this.retireOperation();
    }
    const operation = { client, generation: ++this.generation };
    this.operation = operation;
    this.setState({ phase: "requesting" });
    void client
      .requestScopeUpgrade({
        onPending: (requestId) => {
          if (this.isCurrent(operation)) {
            this.setState({ phase: "pending", requestId });
          }
        },
      })
      .then((result) => {
        if (!this.isCurrent(operation) || result.status === "approved") {
          return;
        }
        this.setState({
          phase: "rejected",
          requestId: result.requestId,
          expired: result.status === "expired",
        });
      })
      .catch((error: unknown) => {
        if (!this.isCurrent(operation) || (error instanceof Error && error.name === "AbortError")) {
          return;
        }
        this.setState({ phase: "error", message: formatUiError(error) });
      })
      .finally(() => {
        if (this.isCurrent(operation)) {
          this.operation = null;
        }
      });
  }

  private isCurrent(operation: UpgradeOperation): boolean {
    return this.operation === operation && this.current.client === operation.client;
  }

  private retireOperation(): void {
    const operation = this.operation;
    this.operation = null;
    this.generation += 1;
    operation?.client.cancelScopeUpgrade();
  }

  private setState(next: ScopeUpgradeState): void {
    if (this.value.phase === next.phase && JSON.stringify(this.value) === JSON.stringify(next)) {
      return;
    }
    this.value = next;
    this.onChange();
  }
}
