import { describe, expect, it } from "vitest";
import { WhatsAppConfigSchema } from "../config-api.js";

function expectWhatsAppConfigValid(config: unknown) {
  const res = WhatsAppConfigSchema.safeParse(config);
  expect(res.success).toBe(true);
  return res;
}

describe("whatsapp config schema", () => {
  it('rejects dmPolicy="open" without allowFrom "*"', () => {
    const res = WhatsAppConfigSchema.safeParse({
      dmPolicy: "open",
      allowFrom: ["+15555550123"],
    });

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues[0]?.path.join(".")).toBe("allowFrom");
    }
  });

  it('accepts dmPolicy="open" with allowFrom "*"', () => {
    const res = WhatsAppConfigSchema.safeParse({ dmPolicy: "open", allowFrom: ["*"] });

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.dmPolicy).toBe("open");
    }
  });

  it("defaults dm/group policy", () => {
    const res = WhatsAppConfigSchema.safeParse({});

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.dmPolicy).toBe("pairing");
      expect(res.data.groupPolicy).toBe("allowlist");
    }
  });

  it("accepts historyLimit overrides per account", () => {
    const res = WhatsAppConfigSchema.safeParse({
      historyLimit: 9,
      accounts: { work: { historyLimit: 4 } },
    });

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.historyLimit).toBe(9);
      expect(res.data.accounts?.work?.historyLimit).toBe(4);
    }
  });

  it("accepts textChunkLimit", () => {
    const res = expectWhatsAppConfigValid({
      allowFrom: ["+15555550123"],
      textChunkLimit: 4444,
    });

    if (res.success) {
      expect(res.data.textChunkLimit).toBe(4444);
    }
  });

  it("accepts enabled", () => {
    expectWhatsAppConfigValid({
      enabled: true,
    });
  });

  it("keeps inherited account defaults unset at account scope", () => {
    const res = expectWhatsAppConfigValid({
      dmPolicy: "allowlist",
      groupPolicy: "open",
      debounceMs: 250,
      allowFrom: ["+15550001111"],
      accounts: {
        work: {
          allowFrom: ["+15550002222"],
        },
      },
    });

    if (!res.success) {
      return;
    }
    expect(res.data.dmPolicy).toBe("allowlist");
    expect(res.data.groupPolicy).toBe("open");
    expect(res.data.debounceMs).toBe(250);
    expect(res.data.accounts?.work?.dmPolicy).toBeUndefined();
    expect(res.data.accounts?.work?.groupPolicy).toBeUndefined();
    expect(res.data.accounts?.work?.debounceMs).toBeUndefined();
  });

  it("accepts allowlist accounts inheriting allowFrom from accounts.default", () => {
    expectWhatsAppConfigValid({
      accounts: {
        default: {
          allowFrom: ["+15550001111"],
        },
        work: {
          dmPolicy: "allowlist",
        },
      },
    });
  });

  it("accepts allowlist accounts inheriting allowFrom from mixed-case accounts.Default", () => {
    expectWhatsAppConfigValid({
      accounts: {
        Default: {
          allowFrom: ["+15550001111"],
        },
        work: {
          dmPolicy: "allowlist",
        },
      },
    });
  });
});
