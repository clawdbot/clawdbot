import type { GatewayBrowserClient } from "../api/gateway.ts";
import { formatUiError } from "../lib/format-error.ts";
import {
  readScopeUpgradeAvailability,
  type ScopeUpgradeState,
} from "./device-scope-upgrade-availability.ts";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";

type UpgradeOperation = { client: GatewayBrowserClient };

/** Owns one live upgrade request independently of whichever UI presents it. */
export class ScopeUpgradeController {
  private current: ApplicationGatewaySnapshot;
  private operation: UpgradeOperation | null = null;
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
    const availability = readScopeUpgradeAvailability(snapshot);
    if (!client || availability.phase !== "available") {
      this.retireOperation();
      this.setState(availability);
      return;
    }
    if (this.operation && this.operation.client !== client) {
      this.retireOperation();
      this.setState({ phase: "available" });
    }
    if (this.value.phase === "hidden" || this.value.phase === "guidance") {
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
    this.setState(readScopeUpgradeAvailability(this.current));
  }

  dispose(): void {
    this.retireOperation();
  }

  private start(retry: boolean): void {
    const client = this.current.client;
    if (!client || readScopeUpgradeAvailability(this.current).phase !== "available") {
      return;
    }
    if (this.operation) {
      if (!retry) {
        return;
      }
      this.retireOperation();
    }
    const operation = { client };
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
    operation?.client.cancelScopeUpgrade();
  }

  private setState(next: ScopeUpgradeState): void {
    if (JSON.stringify(this.value) === JSON.stringify(next)) {
      return;
    }
    this.value = next;
    this.onChange();
  }
}
