// Update phase tests cover doctor behavior during staged update phases.
import { describe, expect, it } from "vitest";
import {
  UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR_ENV,
  UPDATE_IN_PROGRESS_ENV,
  UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV,
  UPDATE_POST_CORE_CONVERGENCE_ENV,
  isLegacyPackageUpdateDoctorPass,
  isLegacyParentWritableUpdateDoctorPass,
  isPostCoreConvergencePass,
  isUpdatePackageSwapInProgress,
  shouldDeferConfiguredPluginInstallRepair,
} from "./update-phase.js";

describe("update-phase env helpers", () => {
  it("treats only OPENCLAW_UPDATE_IN_PROGRESS=1 as package-swap-in-progress", () => {
    expect(isUpdatePackageSwapInProgress({ [UPDATE_IN_PROGRESS_ENV]: "1" })).toBe(true);
    expect(isUpdatePackageSwapInProgress({ [UPDATE_IN_PROGRESS_ENV]: "0" })).toBe(false);
    expect(isUpdatePackageSwapInProgress({})).toBe(false);
  });

  it("treats post-core convergence as a separate phase", () => {
    expect(isPostCoreConvergencePass({ [UPDATE_POST_CORE_CONVERGENCE_ENV]: "1" })).toBe(true);
    expect(isPostCoreConvergencePass({ [UPDATE_POST_CORE_CONVERGENCE_ENV]: "0" })).toBe(false);
  });

  it("does not consider swap-in-progress true when only post-core convergence is set", () => {
    expect(isUpdatePackageSwapInProgress({ [UPDATE_POST_CORE_CONVERGENCE_ENV]: "1" })).toBe(false);
  });

  it("ignores swap-in-progress when post-core convergence is also set (post-core wins)", () => {
    const env = {
      [UPDATE_IN_PROGRESS_ENV]: "1",
      [UPDATE_POST_CORE_CONVERGENCE_ENV]: "1",
    };
    expect(isUpdatePackageSwapInProgress(env)).toBe(false);
    expect(isPostCoreConvergencePass(env)).toBe(true);
  });

  it("defers configured plugin repair for post-core handoffs", () => {
    expect(
      shouldDeferConfiguredPluginInstallRepair({
        [UPDATE_IN_PROGRESS_ENV]: "1",
      }),
    ).toBe(false);
    expect(
      shouldDeferConfiguredPluginInstallRepair({
        [UPDATE_IN_PROGRESS_ENV]: "1",
        [UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR_ENV]: "1",
      }),
    ).toBe(true);
    expect(
      shouldDeferConfiguredPluginInstallRepair({
        [UPDATE_IN_PROGRESS_ENV]: "1",
        [UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV]: "1",
      }),
    ).toBe(true);
    expect(
      shouldDeferConfiguredPluginInstallRepair({
        [UPDATE_IN_PROGRESS_ENV]: "1",
        [UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR_ENV]: "1",
        [UPDATE_POST_CORE_CONVERGENCE_ENV]: "1",
      }),
    ).toBe(false);
  });

  it("identifies legacy package update doctor passes", () => {
    expect(
      isLegacyPackageUpdateDoctorPass({
        [UPDATE_IN_PROGRESS_ENV]: "1",
      }),
    ).toBe(true);
    expect(
      isLegacyPackageUpdateDoctorPass({
        [UPDATE_IN_PROGRESS_ENV]: "1",
        [UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR_ENV]: "1",
      }),
    ).toBe(false);
    expect(
      isLegacyPackageUpdateDoctorPass({
        [UPDATE_IN_PROGRESS_ENV]: "1",
        [UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV]: "1",
      }),
    ).toBe(false);
    expect(
      isLegacyPackageUpdateDoctorPass({
        [UPDATE_IN_PROGRESS_ENV]: "1",
        [UPDATE_POST_CORE_CONVERGENCE_ENV]: "1",
      }),
    ).toBe(false);
  });

  it("identifies writable legacy parents that need old-readable config writes", () => {
    expect(
      isLegacyParentWritableUpdateDoctorPass({
        [UPDATE_IN_PROGRESS_ENV]: "1",
        [UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV]: "1",
      }),
    ).toBe(true);
    expect(
      isLegacyParentWritableUpdateDoctorPass({
        [UPDATE_IN_PROGRESS_ENV]: "1",
        [UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR_ENV]: "1",
        [UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV]: "1",
      }),
    ).toBe(false);
    expect(
      isLegacyParentWritableUpdateDoctorPass({
        [UPDATE_POST_CORE_CONVERGENCE_ENV]: "1",
        [UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV]: "1",
      }),
    ).toBe(false);
  });
});
