import { describe, expect, it } from "vitest";
import { createPluginStateSyncKeyedStore } from "../plugin-state/plugin-state-store.js";
import * as doctorRepairRuntime from "./doctor-repair-runtime.js";
import * as runtimeDoctorMigrations from "./runtime-doctor-migrations.js";
import * as legacyRuntimeDoctor from "./runtime-doctor.js";

describe("legacy runtime-doctor package facade", () => {
  it("is exactly the migration surface plus the published-artifact repair bridge", () => {
    // Bridge names ship for published pre-split doctor artifacts (#124041
    // class); delete them here alongside the runtime-doctor.ts bridge.
    const expected = [
      ...new Set([
        ...Object.keys(runtimeDoctorMigrations),
        ...Object.keys(doctorRepairRuntime),
        "createPluginStateSyncKeyedStore",
      ]),
    ].toSorted();
    expect(Object.keys(legacyRuntimeDoctor).toSorted()).toEqual(expected);
    for (const key of Object.keys(runtimeDoctorMigrations)) {
      expect(legacyRuntimeDoctor[key as keyof typeof legacyRuntimeDoctor]).toBe(
        runtimeDoctorMigrations[key as keyof typeof runtimeDoctorMigrations],
      );
    }
    for (const key of Object.keys(doctorRepairRuntime)) {
      expect(legacyRuntimeDoctor[key as keyof typeof legacyRuntimeDoctor]).toBe(
        doctorRepairRuntime[key as keyof typeof doctorRepairRuntime],
      );
    }
    expect(legacyRuntimeDoctor.createPluginStateSyncKeyedStore).toBe(
      createPluginStateSyncKeyedStore,
    );
  });
});
