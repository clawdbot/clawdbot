// Imessage tests cover the outbound target resolution contract that core
// resolve and dry-run paths share with the send handler.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { imessagePlugin } from "./channel.js";

const resolveTarget = imessagePlugin.outbound?.resolveTarget;

const cfgWithService = (service?: string): OpenClawConfig =>
  ({
    channels: { imessage: service ? { service } : {} },
  }) as OpenClawConfig;

describe("imessage outbound resolveTarget", () => {
  it("rejects short phone-like handles once the resolved service is not sms", () => {
    expect(resolveTarget?.({ cfg: cfgWithService(), to: "5" })).toMatchObject({
      ok: false,
    });
  });

  it("accepts short codes when the target explicitly selects sms", () => {
    expect(resolveTarget?.({ cfg: cfgWithService(), to: "sms:5" })).toEqual({
      ok: true,
      to: "sms:5",
    });
  });

  it("accepts short codes when the account config selects sms", () => {
    expect(resolveTarget?.({ cfg: cfgWithService("sms"), to: "5" })).toEqual({
      ok: true,
      to: "5",
    });
  });

  it("accepts full phone handles, email handles, and chat rows", () => {
    for (const to of ["+14155551234", "user@example.com", "chat_id:5"]) {
      expect(resolveTarget?.({ cfg: cfgWithService(), to })).toEqual({ ok: true, to });
    }
  });

  it("cannot judge a target without account config, so it stays permissive", () => {
    expect(resolveTarget?.({ to: "5" })).toEqual({ ok: true, to: "5" });
  });

  it("rejects empty targets", () => {
    expect(resolveTarget?.({ cfg: cfgWithService(), to: "" })).toMatchObject({ ok: false });
  });
});
