import type { OpenClawConfig } from "../config/types.openclaw.js";

export type ConfigReloadObservation = Readonly<{
  generation: number;
  sourceConfig: OpenClawConfig | null;
}>;

// The reloader owns config-source reads. Publish one immutable record so health
// cannot combine a generation from one transaction with source from another.
let configReloadObservation: ConfigReloadObservation = {
  generation: 0,
  sourceConfig: null,
};

export function publishConfigReloadObservation(sourceConfig: OpenClawConfig | null): void {
  configReloadObservation = {
    generation: configReloadObservation.generation + 1,
    sourceConfig,
  };
}

export function getConfigReloadObservation(): ConfigReloadObservation {
  return configReloadObservation;
}
