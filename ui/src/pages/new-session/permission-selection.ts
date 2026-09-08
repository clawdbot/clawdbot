import type { SessionPermissionMode } from "../../../../packages/gateway-protocol/src/index.js";

export class NewSessionPermissionSelection {
  value: SessionPermissionMode | undefined;
  private onMutation?: () => void;

  constructor(private readonly requestUpdate: () => void) {}

  setMutationCallback(callback: () => void) {
    this.onMutation = callback;
  }

  set(value: SessionPermissionMode | undefined) {
    this.value = value;
    this.onMutation?.();
    this.requestUpdate();
  }

  restore(value: SessionPermissionMode | undefined) {
    this.value = value;
  }

  reset() {
    this.value = undefined;
  }
}
