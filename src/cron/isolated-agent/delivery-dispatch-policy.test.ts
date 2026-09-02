// Focused regression for direct cron delivery retry classification: a
// proven-not-sent local channel resolution failure must retry, while a
// permanent provider rejection must not.
import { describe, expect, it } from "vitest";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import { retryTransientDirectCronDelivery } from "./delivery-dispatch-policy.js";

describe("retryTransientDirectCronDelivery", () => {
  it("retries a proven-not-sent channel resolution failure", async () => {
    const error = new PlatformMessageNotDispatchedError(
      "Outbound not configured for channel: discord",
      { cause: new Error("Outbound not configured for channel: discord") },
    );
    let attempts = 0;
    const result = await retryTransientDirectCronDelivery({
      jobId: "job-1",
      run: async () => {
        attempts += 1;
        if (attempts < 2) {
          throw error;
        }
        return "delivered";
      },
    });
    expect(result).toBe("delivered");
    expect(attempts).toBe(2);
  });

  it("does not retry a permanent provider rejection", async () => {
    const rejection = new PlatformMessageNotDispatchedError(
      "Platform rejected the message before dispatch",
      { cause: new Error("chat not found"), retryable: false },
    );
    let attempts = 0;
    await expect(
      retryTransientDirectCronDelivery({
        jobId: "job-1",
        run: async () => {
          attempts += 1;
          throw rejection;
        },
      }),
    ).rejects.toBe(rejection);
    expect(attempts).toBe(1);
  });
});
