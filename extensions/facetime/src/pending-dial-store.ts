import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { PendingFaceTimeDial } from "./outbound-call.js";

const PENDING_DIAL_KEY = "active";

type StoredPendingFaceTimeDial = Omit<PendingFaceTimeDial, "callUUIDAliases"> & {
  callUUIDAliases?: string[];
};

function decodePendingDial(
  value: StoredPendingFaceTimeDial | undefined,
): PendingFaceTimeDial | undefined {
  if (
    !value ||
    value.version !== 1 ||
    !Number.isSafeInteger(value.ownerEpoch) ||
    value.ownerEpoch < 1 ||
    typeof value.dialID !== "string" ||
    typeof value.handle !== "string" ||
    (value.mode !== "audio" && value.mode !== "video") ||
    (value.delivery !== "in-flight" &&
      value.delivery !== "accepted" &&
      value.delivery !== "ambiguous" &&
      value.delivery !== "cancelling") ||
    typeof value.requestedAt !== "string"
  ) {
    return undefined;
  }
  const { callUUIDAliases, ...stored } = value;
  return {
    ...stored,
    ...(callUUIDAliases?.length ? { callUUIDAliases: new Set(callUUIDAliases) } : {}),
  };
}

export class PendingFaceTimeDialStore {
  constructor(private readonly store: PluginStateSyncKeyedStore<StoredPendingFaceTimeDial>) {}

  load(): PendingFaceTimeDial | undefined {
    return decodePendingDial(this.store.lookup(PENDING_DIAL_KEY));
  }

  save(pending: PendingFaceTimeDial): void {
    const { callUUIDAliases, ...stored } = pending;
    this.store.register(PENDING_DIAL_KEY, {
      ...stored,
      ...(callUUIDAliases ? { callUUIDAliases: [...callUUIDAliases].toSorted() } : {}),
    });
  }

  clear(expectedDialID: string): boolean {
    if (this.store.deleteIf) {
      return this.store.deleteIf(PENDING_DIAL_KEY, (current) => current.dialID === expectedDialID);
    }
    const current = this.store.lookup(PENDING_DIAL_KEY);
    return current?.dialID === expectedDialID ? this.store.delete(PENDING_DIAL_KEY) : false;
  }
}
