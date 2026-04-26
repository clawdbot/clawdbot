import { describe, expect, it } from "vitest";
import { resolveDoctorHealthContributions } from "./doctor-health-contributions.js";

describe("doctor health contributions", () => {
  it("repairs bundled runtime deps before channel-owned doctor paths can import runtimes", () => {
    const ids = resolveDoctorHealthContributions().map((entry) => entry.id);

    expect(ids.indexOf("doctor:bundled-plugin-runtime-deps")).toBeGreaterThan(-1);
    expect(ids.indexOf("doctor:bundled-plugin-runtime-deps")).toBeLessThan(
      ids.indexOf("doctor:auth-profiles"),
    );
    expect(ids.indexOf("doctor:bundled-plugin-runtime-deps")).toBeLessThan(
      ids.indexOf("doctor:startup-channel-maintenance"),
    );
  });

  it("runs plugin registry repair before final config writes", () => {
    const ids = resolveDoctorHealthContributions().map((entry) => entry.id);

    expect(ids.indexOf("doctor:plugin-registry")).toBeGreaterThan(-1);
    expect(ids.indexOf("doctor:plugin-registry")).toBeLessThan(ids.indexOf("doctor:write-config"));
  });
});
