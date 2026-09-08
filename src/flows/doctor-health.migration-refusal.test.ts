import { beforeEach, describe, expect, it, vi } from "vitest";
import { DoctorStateMigrationRefusalError } from "../infra/state-migrations.messages.js";
import { runDoctorHealthFlow } from "./doctor-health.js";
import { mocks } from "./doctor-health.test-support.js";

const maintenance = vi.hoisted(() => ({ finish: vi.fn(), release: vi.fn() }));
vi.mock("../commands/doctor-maintenance.js", () => ({
  beginDoctorMaintenance: async () => maintenance,
}));

describe("Doctor refused-migration maintenance outcome", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.config.mockReturnValue({});
    mocks.packageRoot.mockReturnValue(undefined);
  });

  it.each([true, false])(
    "releases maintenance after migration refusal=%s",
    async (migrationRefusal) => {
      const failure = migrationRefusal
        ? new DoctorStateMigrationRefusalError([])
        : new Error("service repair failed");
      mocks.runContributions.mockRejectedValueOnce(failure);
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      await expect(
        runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true }),
      ).rejects.toBe(failure);
      expect(maintenance.release).toHaveBeenCalledOnce();
      expect(maintenance.finish).not.toHaveBeenCalled();
      expect(mocks.outro).not.toHaveBeenCalled();
      if (migrationRefusal) {
        expect(runtime.error).not.toHaveBeenCalled();
      } else {
        expect(runtime.error).toHaveBeenCalledWith(
          expect.stringContaining("Check the reported service state"),
        );
      }
    },
  );
});
