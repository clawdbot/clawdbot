import { describe, expect, it } from "vitest";
import { formatStartupPluginVerificationFailure } from "./doctor-config-preflight-plugin-verification.js";

describe("formatStartupPluginVerificationFailure", () => {
  it("uses install-neutral gateway restart guidance", () => {
    expect(
      formatStartupPluginVerificationFailure({
        kind: "plugin-verification",
        messages: ['Plugin "discord" has no install path.'],
      }),
    ).toBe(
      [
        "OpenClaw plugin verification failed; refusing to report the gateway ready.",
        '- Plugin "discord" has no install path.',
        "Resolve the plugin verification errors above, then restart the Gateway.",
      ].join("\n"),
    );
  });
});
