import { describe, expect, it } from "vitest";

import type { ClawdbotConfig } from "../config/config.js";
import {
  mergeWhatsAppConfig,
  setWhatsAppAllowFrom,
  setWhatsAppDmPolicy,
  setWhatsAppSelfChatMode,
} from "./onboard-providers.js";

describe("onboard-providers WhatsApp setters", () => {
  it("preserves existing WhatsApp fields when updating allowFrom", () => {
    const cfg: ClawdbotConfig = {
      whatsapp: {
        selfChatMode: true,
        dmPolicy: "pairing",
        allowFrom: ["*"],
        accounts: {
          default: { enabled: false },
        },
      },
    };

    const next = setWhatsAppAllowFrom(cfg, ["+15555550123"]);

    expect(next.whatsapp?.selfChatMode).toBe(true);
    expect(next.whatsapp?.dmPolicy).toBe("pairing");
    expect(next.whatsapp?.allowFrom).toEqual(["+15555550123"]);
    expect(next.whatsapp?.accounts?.default?.enabled).toBe(false);
  });

  it("updates dmPolicy without dropping selfChatMode", () => {
    const cfg: ClawdbotConfig = {
      whatsapp: {
        selfChatMode: true,
        dmPolicy: "pairing",
      },
    };

    const next = setWhatsAppDmPolicy(cfg, "open");

    expect(next.whatsapp?.dmPolicy).toBe("open");
    expect(next.whatsapp?.selfChatMode).toBe(true);
  });

  it("updates selfChatMode without dropping allowFrom", () => {
    const cfg: ClawdbotConfig = {
      whatsapp: {
        allowFrom: ["+15555550123"],
      },
    };

    const next = setWhatsAppSelfChatMode(cfg, true);

    expect(next.whatsapp?.selfChatMode).toBe(true);
    expect(next.whatsapp?.allowFrom).toEqual(["+15555550123"]);
  });

  it("merges WhatsApp config without clobbering fields", () => {
    const cfg: ClawdbotConfig = {
      whatsapp: {
        dmPolicy: "pairing",
        allowFrom: ["*"],
      },
    };

    const merged = mergeWhatsAppConfig(cfg, {
      dmPolicy: "open",
      allowFrom: undefined,
    });
    const cleared = mergeWhatsAppConfig(
      cfg,
      { allowFrom: undefined },
      { unsetOnUndefined: ["allowFrom"] },
    );

    expect(merged.whatsapp?.dmPolicy).toBe("open");
    expect(merged.whatsapp?.allowFrom).toEqual(["*"]);
    expect(cleared.whatsapp?.allowFrom).toBeUndefined();
  });
});
