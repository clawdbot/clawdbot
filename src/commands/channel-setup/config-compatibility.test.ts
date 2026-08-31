import { describe, expect, it } from "vitest";
import { normalizeExternalChannelSetupConfig } from "./config-compatibility.js";

describe("normalizeExternalChannelSetupConfig", () => {
  it("normalizes Tencent 2.0 setup defaults through the host compatibility migration", () => {
    const previous = {
      channels: {
        qqbot: {
          appId: "app-id",
          clientSecret: "secret",
          allowFrom: ["*"],
        },
      },
    };

    const next = normalizeExternalChannelSetupConfig({ cfg: previous, channel: "qqbot" });

    expect(next).toMatchObject({
      channels: {
        qqbot: {
          appId: "app-id",
          clientSecret: "secret",
          dmPolicy: "open",
          allowFrom: ["openclaw:approval-disabled"],
        },
      },
    });
    expect(previous.channels.qqbot).toEqual({
      appId: "app-id",
      clientSecret: "secret",
      allowFrom: ["*"],
    });
  });

  it("leaves channels without a host compatibility migration unchanged", () => {
    const cfg = { channels: { telegram: { enabled: true } } };

    expect(normalizeExternalChannelSetupConfig({ cfg, channel: "telegram" })).toBe(cfg);
  });
});
