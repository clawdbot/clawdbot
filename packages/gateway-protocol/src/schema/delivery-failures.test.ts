import { describe, expect, it } from "vitest";
import {
  DeliveryFailureResubmitParamsSchema,
  DeliveryFailureResubmitResultSchema,
  validateDeliveryFailureResubmitParams,
  validateDeliveryFailureResubmitResult,
} from "../index.js";
import { ProtocolSchemas } from "./protocol-schemas.js";

describe("delivery failure resubmit protocol", () => {
  it("registers closed params and metadata-only result schemas", () => {
    expect(ProtocolSchemas.DeliveryFailureResubmitParams).toBe(DeliveryFailureResubmitParamsSchema);
    expect(ProtocolSchemas.DeliveryFailureResubmitResult).toBe(DeliveryFailureResubmitResultSchema);

    expect(validateDeliveryFailureResubmitParams({ id: "stable-id", queueName: "session" })).toBe(
      true,
    );
    expect(validateDeliveryFailureResubmitParams({ id: "stable-id", payload: "secret" })).toBe(
      false,
    );
    expect(validateDeliveryFailureResubmitParams({ id: "" })).toBe(false);
  });

  it("keeps success dispositions and refusal reasons as closed wire states", () => {
    for (const disposition of ["scheduled", "queued_for_startup", "queued_for_recovery"] as const) {
      expect(
        validateDeliveryFailureResubmitResult({
          ok: true,
          queueName: "session",
          disposition,
        }),
      ).toBe(true);
    }
    expect(
      validateDeliveryFailureResubmitResult({
        ok: false,
        queueName: "session",
        reason: "ambiguous_queue",
      }),
    ).toBe(true);

    expect(
      validateDeliveryFailureResubmitResult({
        ok: true,
        queueName: "session",
        disposition: "scheduled",
        scheduled: false,
      }),
    ).toBe(false);
    expect(
      validateDeliveryFailureResubmitResult({
        ok: false,
        reason: "provider said no",
        rawError: "secret",
      }),
    ).toBe(false);
  });
});
