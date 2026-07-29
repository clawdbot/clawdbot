import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor";
import { dreamingStateMigration } from "./src/migration/doctor-dreaming-state.js";
import { hostEventsStateMigration } from "./src/migration/doctor-host-events.js";
import {
  memorySidecarStateMigration,
  qmdLocksStateMigration,
} from "./src/migration/doctor-memory-sidecar.js";

export const stateMigrations: PluginDoctorStateMigration[] = [
  hostEventsStateMigration,
  dreamingStateMigration,
  memorySidecarStateMigration,
  qmdLocksStateMigration,
];
