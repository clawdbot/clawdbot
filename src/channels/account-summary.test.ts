import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildChannelAccountSnapshot } from "./account-summary.js";
import type { ChannelPlugin } from "./plugins/types.plugin.js";

describe("buildChannelAccountSnapshot", () => {
  it("redacts a raw baseUrl returned by describeAccount without mutating the account", () => {
    const rawBaseUrl = [
      "https://",
      "user",
      ":",
      "pass",
      "@",
      "chat.example.test/?token=",
      "secret",
    ].join("");
    const account = Object.freeze({
      baseUrl: "https://safe.example.test/",
    });
    const plugin = {
      config: {
        describeAccount: () => ({
          baseUrl: rawBaseUrl,
        }),
      },
    } as unknown as ChannelPlugin;

    const snapshot = buildChannelAccountSnapshot({
      plugin,
      account,
      cfg: {} as OpenClawConfig,
      accountId: "default",
      enabled: true,
      configured: true,
    });

    expect(snapshot.baseUrl).toBe("https://chat.example.test/?token=***");
    expect(account.baseUrl).toBe("https://safe.example.test/");
  });
});
