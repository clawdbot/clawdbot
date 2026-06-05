// Session send policy tests cover message send eligibility decisions.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { resolveSendPolicy } from "./send-policy.js";

describe("resolveSendPolicy", () => {
  const cfgWithRules = (
    rules: NonNullable<NonNullable<OpenClawConfig["session"]>["sendPolicy"]>["rules"],
  ) =>
    ({
      session: {
        sendPolicy: {
          default: "allow",
          rules,
        },
      },
    }) as OpenClawConfig;

  it("defaults to allow", () => {
    const cfg = {} as OpenClawConfig;
    expect(resolveSendPolicy({ cfg })).toBe("allow");
  });

  it("entry override wins", () => {
    const cfg = {
      session: { sendPolicy: { default: "allow" } },
    } as OpenClawConfig;
    const entry: SessionEntry = {
      sessionId: "s",
      updatedAt: 0,
      sendPolicy: "deny",
    };
    expect(resolveSendPolicy({ cfg, entry })).toBe("deny");
  });

  it.each([
    {
      name: "rule match by channel + chatType",
      cfg: cfgWithRules([
        { action: "deny", match: { channel: "demo-channel", chatType: "group" } },
      ]),
      entry: {
        sessionId: "s",
        updatedAt: 0,
        channel: "demo-channel",
        chatType: "group",
      } as SessionEntry,
      sessionKey: "demo-channel:group:dev",
      expected: "deny",
    },
    {
      name: "rule match by keyPrefix",
      cfg: cfgWithRules([{ action: "deny", match: { keyPrefix: "cron:" } }]),
      sessionKey: "cron:job-1",
      expected: "deny",
    },
    {
      name: "rule match by rawKeyPrefix",
      cfg: cfgWithRules([{ action: "deny", match: { rawKeyPrefix: "agent:main:demo-channel:" } }]),
      sessionKey: "agent:main:demo-channel:group:dev",
      expected: "deny",
    },
    {
      name: "rawKeyPrefix does not match other channels",
      cfg: cfgWithRules([{ action: "deny", match: { rawKeyPrefix: "agent:main:demo-channel:" } }]),
      sessionKey: "agent:main:other-channel:group:dev",
      expected: "allow",
    },
  ])("$name", ({ cfg, entry, sessionKey, expected }) => {
    expect(resolveSendPolicy({ cfg, entry, sessionKey })).toBe(expected);
  });
});
