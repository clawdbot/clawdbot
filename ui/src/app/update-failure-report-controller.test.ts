// @vitest-environment node
import { expect, it, vi } from "vitest";

vi.mock("typebox", () => {
  throw new Error("Startup report eligibility must not evaluate protocol schema builders");
});

it("loads report eligibility without evaluating protocol schema builders", async () => {
  await expect(import("./update-failure-report-controller.ts")).resolves.toMatchObject({
    canReportUpdateFailure: expect.any(Function),
    createUpdateFailureReportController: expect.any(Function),
  });
});
