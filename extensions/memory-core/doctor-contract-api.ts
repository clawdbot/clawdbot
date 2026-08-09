import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { dreamingStateMigration } from "./src/migration/doctor-dreaming-state.js";
import { hostEventsStateMigration } from "./src/migration/doctor-host-events.js";
import {
  memorySidecarStateMigration,
  qmdLocksStateMigration,
} from "./src/migration/doctor-memory-sidecar.js";
import { vectorIndexProviderDiagnostic } from "./src/migration/doctor-vector-index-provider.js";

export const stateMigrations: PluginDoctorStateMigration[] = [
  hostEventsStateMigration,
  dreamingStateMigration,
  memorySidecarStateMigration,
  qmdLocksStateMigration,
  vectorIndexProviderDiagnostic,
];
