// Zalouser tests cover accounts plugin behavior.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import {
  listZalouserAccountIds,
  resolveDefaultZalouserAccountId,
  resolveZalouserAccountSync,
} from "./accounts.js";
const originalZalouserProfile = process.env.ZALOUSER_PROFILE;
const originalZcaProfile = process.env.ZCA_PROFILE;

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

describe("zalouser account resolution", () => {
  beforeEach(() => {
    delete process.env.ZALOUSER_PROFILE;
    delete process.env.ZCA_PROFILE;
  });

  afterEach(() => {
    if (originalZalouserProfile === undefined) {
      delete process.env.ZALOUSER_PROFILE;
    } else {
      process.env.ZALOUSER_PROFILE = originalZalouserProfile;
    }
    if (originalZcaProfile === undefined) {
      delete process.env.ZCA_PROFILE;
    } else {
      process.env.ZCA_PROFILE = originalZcaProfile;
    }
  });

  it("preserves top-level default account when named accounts are configured", () => {
    const cfg = asConfig({
      channels: {
        zalouser: {
          profile: "personal",
          accounts: {
            work: { enabled: false },
          },
        },
      },
    });

    expect(listZalouserAccountIds(cfg)).toEqual(["default", "work"]);
    expect(resolveDefaultZalouserAccountId(cfg)).toBe("default");
    expect(resolveZalouserAccountSync({ cfg }).profile).toBe("personal");
  });

  it("uses configured defaultAccount when present", () => {
    const cfg = asConfig({
      channels: {
        zalouser: {
          defaultAccount: "work",
          accounts: {
            default: {},
            work: {},
          },
        },
      },
    });

    expect(resolveDefaultZalouserAccountId(cfg)).toBe("work");
  });

  it("resolves sync account by merging base + account config", () => {
    const cfg = asConfig({
      channels: {
        zalouser: {
          enabled: true,
          dmPolicy: "pairing",
          accounts: {
            work: {
              enabled: false,
              name: "Work",
              dmPolicy: "allowlist",
              allowFrom: ["123"],
            },
          },
        },
      },
    });

    const resolved = resolveZalouserAccountSync({ cfg, accountId: "work" });
    expect(resolved.accountId).toBe("work");
    expect(resolved.enabled).toBe(false);
    expect(resolved.name).toBe("Work");
    expect(resolved.config.dmPolicy).toBe("allowlist");
    expect(resolved.config.allowFrom).toEqual(["123"]);
  });

  it("uses configured defaultAccount when accountId is omitted", () => {
    const cfg = asConfig({
      channels: {
        zalouser: {
          defaultAccount: "work",
          accounts: {
            work: {
              name: "Work",
              profile: "work-profile",
            },
          },
        },
      },
    });

    const resolved = resolveZalouserAccountSync({ cfg });
    expect(resolved.accountId).toBe("work");
    expect(resolved.name).toBe("Work");
    expect(resolved.profile).toBe("work-profile");
  });

  it("resolves account config when account key casing differs from normalized id", () => {
    const cfg = asConfig({
      channels: {
        zalouser: {
          accounts: {
            Work: {
              name: "Work",
            },
          },
        },
      },
    });

    const resolved = resolveZalouserAccountSync({ cfg, accountId: "work" });
    expect(resolved.accountId).toBe("work");
    expect(resolved.name).toBe("Work");
  });

  it("defaults group policy to allowlist when unset", () => {
    const cfg = asConfig({
      channels: {
        zalouser: {
          enabled: true,
        },
      },
    });

    const resolved = resolveZalouserAccountSync({ cfg, accountId: "default" });
    expect(resolved.config.groupPolicy).toBe("allowlist");
  });

  it("resolves profile precedence correctly", () => {
    const cfg = asConfig({
      channels: {
        zalouser: {
          accounts: {
            work: {},
          },
        },
      },
    });

    process.env.ZALOUSER_PROFILE = "zalo-env";
    expect(resolveZalouserAccountSync({ cfg, accountId: "work" }).profile).toBe("zalo-env");

    delete process.env.ZALOUSER_PROFILE;
    process.env.ZCA_PROFILE = "zca-env";
    expect(resolveZalouserAccountSync({ cfg, accountId: "work" }).profile).toBe("zca-env");

    delete process.env.ZCA_PROFILE;
    expect(resolveZalouserAccountSync({ cfg, accountId: "work" }).profile).toBe("work");
  });

  it("uses explicit profile from config over env fallback", () => {
    process.env.ZALOUSER_PROFILE = "env-profile";
    const cfg = asConfig({
      channels: {
        zalouser: {
          accounts: {
            work: {
              profile: "explicit-profile",
            },
          },
        },
      },
    });

    expect(resolveZalouserAccountSync({ cfg, accountId: "work" }).profile).toBe("explicit-profile");
  });
});
