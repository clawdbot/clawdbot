import { expectDefined } from "@openclaw/normalization-core";
// Hook install record helpers read and write installed hook metadata.
import type { HookInstallRecord } from "../config/types.hooks.js";
import { updateConfigMachineState } from "../state/config-machine-state-write.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";

/** Install record plus its canonical hook pack id. */
export type HookInstallUpdate = HookInstallRecord & { hookId: string };

export type HookInstallWriteReceipt = {
  hookId: string;
  previous?: HookInstallRecord;
  writtenJson: string;
  bucketExisted: boolean;
};

/** Read canonical hook install records from machine state. */
export function readHookInstalls(
  options: OpenClawStateDatabaseOptions = {},
): Record<string, HookInstallRecord> {
  return (
    readConfigMachineState<Record<string, HookInstallRecord>>("hooks.internal.installs", options) ??
    {}
  );
}

/** Persist one hook install record in machine state. */
export function recordHookInstall(
  update: HookInstallUpdate,
  options: OpenClawStateDatabaseOptions = {},
): HookInstallWriteReceipt {
  const { hookId, ...record } = update;
  let receipt: HookInstallWriteReceipt | undefined;
  updateConfigMachineState<Record<string, HookInstallRecord>>(
    "hooks.internal.installs",
    (current) => {
      const previous = current && Object.hasOwn(current, hookId) ? current[hookId] : undefined;
      const written = {
        ...previous,
        ...record,
        installedAt: record.installedAt ?? new Date().toISOString(),
      };
      receipt = {
        hookId,
        previous,
        // Compare the persisted shape: optional undefined fields disappear in SQLite JSON.
        writtenJson: JSON.stringify(written),
        bucketExisted: current !== undefined,
      };
      return { ...current, [hookId]: written };
    },
    options,
  );
  return expectDefined(receipt, "hook install write receipt");
}

/** Undo only this install's record, preserving unrelated or newer writers. */
export function restoreHookInstallIfCurrent(
  receipt: HookInstallWriteReceipt,
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  let restored = false;
  updateConfigMachineState<Record<string, HookInstallRecord>>(
    "hooks.internal.installs",
    (current) => {
      if (
        !current ||
        !Object.hasOwn(current, receipt.hookId) ||
        JSON.stringify(current[receipt.hookId]) !== receipt.writtenJson
      ) {
        return current;
      }
      const next = { ...current };
      if (receipt.previous) {
        next[receipt.hookId] = receipt.previous;
      } else {
        delete next[receipt.hookId];
      }
      restored = true;
      return !receipt.bucketExisted && Object.keys(next).length === 0 ? undefined : next;
    },
    options,
  );
  return restored;
}
