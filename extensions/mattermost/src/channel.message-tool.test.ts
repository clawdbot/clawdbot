// Mattermost tests cover account-isolated message-tool discovery.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import { mattermostPlugin } from "./channel.js";

describe("Mattermost message-tool SecretRef inspection", () => {
  const cfg = {
    channels: {
      mattermost: {
        accounts: {
          broken: {
            botToken: {
              source: "env",
              provider: "default",
              id: "OPENCLAW_TEST_MISSING_MATTERMOST_TOKEN",
            },
            baseUrl: "https://mm.example.com",
          },
          healthy: { botToken: "healthy-token", baseUrl: "https://mm.example.com" },
        },
      },
    },
  } as OpenClawConfig;

  it("keeps healthy account actions discoverable", () => {
    expect(mattermostPlugin.actions?.describeMessageTool({ cfg })?.actions).toEqual(
      expect.arrayContaining(["send", "react"]),
    );
  });

  it("does not advertise actions for the unavailable selected account", () => {
    expect(
      mattermostPlugin.actions?.describeMessageTool({ cfg, accountId: "broken" })?.actions,
    ).toEqual([]);
  });
});
