import { describe, expect, it } from "vitest";
import {
  resolveWhatsAppGroupRequireMention,
  resolveWhatsAppGroupToolPolicy,
} from "./group-policy.js";
import type { OpenClawConfig } from "./runtime-api.js";

describe("whatsapp group policy", () => {
  it("uses generic channel group policy helpers", () => {
    const cfg = {
      channels: {
        whatsapp: {
          groups: {
            "1203630@g.us": {
              requireMention: false,
              tools: { deny: ["exec"] },
            },
            "*": {
              requireMention: true,
              tools: { allow: ["message.send"] },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveWhatsAppGroupRequireMention({ cfg, groupId: "1203630@g.us" })).toBe(false);
    expect(resolveWhatsAppGroupRequireMention({ cfg, groupId: "other@g.us" })).toBe(true);
    expect(resolveWhatsAppGroupToolPolicy({ cfg, groupId: "1203630@g.us" })).toEqual({
      deny: ["exec"],
    });
    expect(resolveWhatsAppGroupToolPolicy({ cfg, groupId: "other@g.us" })).toEqual({
      allow: ["message.send"],
    });
  });
});
