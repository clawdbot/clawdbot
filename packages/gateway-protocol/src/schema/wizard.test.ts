import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import { WizardNextResultSchema, WizardStepSchema } from "./wizard.js";

describe("WizardNextResultSchema", () => {
  const validate = Compile(WizardNextResultSchema);

  it("accepts an exact prepared model on a terminal result", () => {
    expect(
      validate.Check({
        done: true,
        status: "done",
        preparedModelRef: "ollama/qwen3:0.6b",
      }),
    ).toBe(true);
  });

  it("rejects an empty prepared model reference", () => {
    expect(validate.Check({ done: true, status: "done", preparedModelRef: "" })).toBe(false);
  });
});

describe("WizardStepSchema", () => {
  const validate = Compile(WizardStepSchema);
  const qr = {
    id: "qr-1",
    type: "qr",
    title: "Link device",
    qrDataUrl: "data:image/png;base64,aGVsbG8=",
    expiresInMs: 60_000,
    canCancel: true,
    executor: "gateway",
  };

  it("accepts only the closed gateway-owned QR variant", () => {
    expect(validate.Check(qr)).toBe(true);
    expect(validate.Check({ ...qr, executor: "client" })).toBe(false);
    expect(validate.Check({ ...qr, qrDataUrl: undefined })).toBe(false);
    expect(validate.Check({ ...qr, canCancel: false })).toBe(true);
    expect(validate.Check({ ...qr, sensitive: true })).toBe(false);
  });

  it("keeps QR-only fields off interactive steps", () => {
    expect(validate.Check({ id: "text-1", type: "text", qrDataUrl: qr.qrDataUrl })).toBe(false);
    expect(validate.Check({ id: "text-1", type: "text", canCancel: true })).toBe(false);
  });

  it("bounds QR expiry to timer-safe delays", () => {
    expect(validate.Check({ ...qr, expiresInMs: MAX_TIMER_TIMEOUT_MS })).toBe(true);
    expect(validate.Check({ ...qr, expiresInMs: MAX_TIMER_TIMEOUT_MS + 1 })).toBe(false);
  });
});
