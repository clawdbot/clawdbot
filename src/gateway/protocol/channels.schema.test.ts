import AjvPkg from "ajv";
import { describe, expect, it } from "vitest";
import { WebLoginWaitParamsSchema } from "./schema/channels.js";

describe("WebLoginWaitParamsSchema", () => {
  const Ajv = AjvPkg as unknown as new (opts?: object) => import("ajv").default;
  const validate = new Ajv().compile(WebLoginWaitParamsSchema);

  it("bounds caller-provided QR data URLs", () => {
    expect(
      validate({
        currentQrDataUrl: "data:image/png;base64,qr",
      }),
    ).toBe(true);

    expect(
      validate({
        currentQrDataUrl: "x".repeat(16_385),
      }),
    ).toBe(false);
    expect(
      validate({
        currentQrDataUrl: "https://example.com/qr.png",
      }),
    ).toBe(false);
  });
});
