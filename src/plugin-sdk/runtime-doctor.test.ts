import { describe, expect, it } from "vitest";
import * as runtimeDoctorMigrations from "./runtime-doctor-migrations.js";
import * as legacyRuntimeDoctor from "./runtime-doctor.js";

describe("legacy runtime-doctor package facade", () => {
  it("is exactly the dependency-light migration surface", () => {
    expect(Object.keys(legacyRuntimeDoctor).toSorted()).toEqual(
      Object.keys(runtimeDoctorMigrations).toSorted(),
    );
    for (const key of Object.keys(runtimeDoctorMigrations)) {
      expect(legacyRuntimeDoctor[key as keyof typeof legacyRuntimeDoctor]).toBe(
        runtimeDoctorMigrations[key as keyof typeof runtimeDoctorMigrations],
      );
    }
  });
});
