// Devices page dialog orchestration. One owner holds every awaited dialog so
// the page controller stays under its max-lines budget: destructive actions
// confirm through the shared dialog and revalidate the captured connection
// scope after the await, and the alias editor reuses the same single-dialog
// slot so a reconnect aborts whichever dialog is open.
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { showConfirmDialog, type ConfirmDialogOptions } from "../../components/confirm-dialog.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { DevicesPageDataState, InventoryRemovalRequest } from "../../lib/nodes/index.ts";
import {
  rejectDevicePairing,
  rejectNodePairingRequest,
  removeInventoryEntry,
  removeStaleInventoryEntries,
  renameDevice,
  revokeDeviceToken,
} from "../../lib/nodes/index.ts";

export type DeviceAliasTarget = {
  id: string;
  name: string;
  operatorLabel?: string;
};

type InventoryRemovalPrompt =
  | { kind: "entry"; entry: InventoryRemovalRequest }
  | { kind: "stale"; entries: InventoryRemovalRequest[] };

/** Narrow seam the page controller implements; dialogs never see page internals. */
export type DevicesDialogHost = {
  canManagePairing: () => boolean;
  gatewayConnected: () => boolean;
  requestGeneration: () => number;
  gatewayClient: () => GatewayBrowserClient | null;
  gatewayUrl: () => string;
  runPageTask: <T>(task: (pageState: DevicesPageDataState) => T | Promise<T>) => Promise<T>;
  pendingDialog: () => AbortController | null;
  setPendingDialog: (controller: AbortController | null) => void;
  setDevicesError: (message: string) => void;
};

export class DevicesDialogController {
  constructor(private readonly host: DevicesDialogHost) {}

  /**
   * Opens the alias editor for one paired device through the shared input
   * dialog. The dialog's submit runs the rename under the current page scope
   * and a rejected attempt stays visible and retryable. It shares the page's
   * pending-dialog slot, so a reconnect aborts it and no second dialog can
   * stack on top of a destructive confirmation (or vice versa).
   */
  async editAlias(device: DeviceAliasTarget): Promise<void> {
    if (!this.host.canManagePairing() || this.host.pendingDialog()) {
      return;
    }
    const controller = new AbortController();
    this.host.setPendingDialog(controller);
    try {
      const { showInputDialog } = await import("../../components/input-dialog.ts");
      await showInputDialog({
        signal: controller.signal,
        title: t("devices.inventory.renameTitle", { name: device.name }),
        label: t("devices.inventory.renamePrompt"),
        defaultValue: device.operatorLabel ?? "",
        requireValue: true,
        requireChange: true,
        submit: (label) => {
          if (!this.host.canManagePairing()) {
            return Promise.resolve(t("devices.readOnly.pairingRequired"));
          }
          return this.host.runPageTask((pageState) =>
            renameDevice(pageState, { deviceId: device.id, label }),
          );
        },
      });
    } catch (error) {
      this.host.setDevicesError(formatUiError(error));
    } finally {
      if (this.host.pendingDialog() === controller) {
        this.host.setPendingDialog(null);
      }
    }
  }

  confirmInventoryRemoval(prompt: InventoryRemovalPrompt): Promise<void> {
    if (!this.host.canManagePairing()) {
      return Promise.resolve();
    }
    if (prompt.kind === "entry") {
      const entry = prompt.entry;
      return this.confirmDestructiveAction(
        {
          title: t("devices.inventory.removePromptTitle", { name: entry.name }),
          message: t("devices.inventory.removePromptBody"),
          details: t("devices.inventory.deviceId", { id: entry.id }),
          confirmLabel: t("devices.inventory.remove"),
        },
        (pageState) => removeInventoryEntry(pageState, entry),
      );
    }
    const entries = prompt.entries;
    return this.confirmDestructiveAction(
      {
        title: t(
          entries.length === 1
            ? "devices.inventory.removeStalePromptTitleOne"
            : "devices.inventory.removeStalePromptTitle",
          { count: String(entries.length) },
        ),
        message: t("devices.inventory.removeStalePromptBody"),
        confirmLabel: t("devices.inventory.remove"),
      },
      (pageState) => removeStaleInventoryEntries(pageState, entries),
    );
  }

  confirmPairingReject(target: "device" | "node", requestId: string): Promise<void> {
    if (!this.host.canManagePairing()) {
      return Promise.resolve();
    }
    return this.confirmDestructiveAction(
      {
        title: t(
          target === "device"
            ? "devices.inventory.rejectDevicePromptTitle"
            : "devices.inventory.rejectNodePromptTitle",
        ),
        message: t("devices.inventory.rejectPromptBody"),
        confirmLabel: t("devices.inventory.reject"),
      },
      (pageState) =>
        target === "device"
          ? rejectDevicePairing(pageState, requestId)
          : rejectNodePairingRequest(pageState, requestId),
    );
  }

  confirmTokenRevoke(deviceId: string, role: string): Promise<void> {
    if (!this.host.canManagePairing()) {
      return Promise.resolve();
    }
    return this.confirmDestructiveAction(
      {
        title: t("devices.inventory.revokePromptTitle", { role }),
        message: t("devices.inventory.revokePromptBody"),
        details: t("devices.inventory.deviceId", { id: deviceId }),
        confirmLabel: t("devices.inventory.revoke"),
      },
      (pageState) =>
        revokeDeviceToken(pageState, {
          deviceId,
          gatewayUrl: this.host.gatewayUrl(),
          role,
        }),
    );
  }

  // Every destructive Devices action confirms here, never through window.confirm: the
  // awaited dialog lets the gateway reconnect or swap clients mid-prompt, so the captured
  // scope and current authority are revalidated before the operation runs.
  private async confirmDestructiveAction(
    prompt: Omit<ConfirmDialogOptions, "danger" | "signal">,
    run: (pageState: DevicesPageDataState) => unknown,
  ) {
    if (this.host.pendingDialog()) {
      return;
    }
    const controller = new AbortController();
    this.host.setPendingDialog(controller);
    const generation = this.host.requestGeneration();
    const client = this.host.gatewayClient();
    const confirmed = await showConfirmDialog({
      ...prompt,
      danger: true,
      signal: controller.signal,
    });
    if (this.host.pendingDialog() === controller) {
      this.host.setPendingDialog(null);
    }
    if (
      !confirmed ||
      controller.signal.aborted ||
      generation !== this.host.requestGeneration() ||
      client !== this.host.gatewayClient() ||
      !this.host.gatewayConnected() ||
      !this.host.canManagePairing()
    ) {
      return;
    }
    await this.host.runPageTask(run);
  }
}
