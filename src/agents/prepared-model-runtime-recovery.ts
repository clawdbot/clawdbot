// Gateway retry hints and the recovery timer share one cadence to avoid client request storms.
export const MODEL_RUNTIME_DISCOVERY_RECOVERY_DELAY_MS = 5_000;
export const MODEL_RUNTIME_DISCOVERY_RECOVERY_MAX_DELAY_MS = 60_000;
