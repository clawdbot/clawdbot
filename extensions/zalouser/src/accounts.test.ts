import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import {
  getZcaUserInfo,
  listEnabledZalouserAccounts,
  listZalouserAccountIds,
  resolveDefaultZalouserAccountId,
  resolveZalouserAccount,
  resolveZalouserAccountSync,
} from "./accounts.js";
import { checkZaloAuthenticated, getZaloUserInfo } from "./zalo-js.js";

vi.mock("./zalo-js.js", () => ({
  checkZaloAuthenticated: vi.fn(),
  getZaloUserInfo: vi.fn(),
}));

const mockCheckAuthenticated = vi.mocked(checkZaloAuthenticated);
const mockGetUserInfo = vi.mocked(getZaloUserInfo);
const originalZalouserProfile = process.env.ZALOUSER_PROFILE;
const originalZcaProfile = process.env.ZCA_PROFILE;

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

describe("zalouser account resolution", () => {
  beforeEach(() => {
    mockCheckAuthenticated.mockReset();
    mockGetUserInfo.mockReset();
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

  it("returns default account id when no accounts are configured", () => {
    expect(listZalouserAccountIds(asConfig({}))).toEqual([DEFAULT_ACCOUNT_ID]);
  });

  it("returns sorted configured account ids", () => {
    const cfg = asConfig({
      channels: {
        zalouser: {
          accounts: {
            work: {},
            personal: {},
            default: {},
          },
        },
      },
    });

    expect(listZalouserAccountIds(cfg)).toEqual(["default", "personal", "work"]);
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

  it("falls back to default account when configured defaultAccount is missing", () => {
    const cfg = asConfig({
      channels: {
        zalouser: {
          defaultAccount: "missing",
          accounts: {
            default: {},
            work: {},
          },
        },
      },
    });

    expect(resolveDefaultZalouserAccountId(cfg)).toBe("default");
  });

  it("falls back to first sorted configured account when default is absent", () => {
    const cfg = asConfig({
      channels: {
        zalouser: {
          accounts: {
            zzz: {},
            aaa: {},
          },
        },
      },
    });

    expect(resolveDefaultZalouserAccountId(cfg)).toBe("aaa");
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

  it("checks authentication during async account resolution", async () => {
    mockCheckAuthenticated.mockResolvedValueOnce(true);
    const cfg = asConfig({
      channels: {
        zalouser: {
          accounts: {
            default: {},
          },
        },
      },
    });

    const resolved = await resolveZalouserAccount({ cfg, accountId: "default" });
    expect(mockCheckAuthenticated).toHaveBeenCalledWith("default");
    expect(resolved.authenticated).toBe(true);
  });

  it("filters disabled accounts when listing enabled accounts", async () => {
    mockCheckAuthenticated.mockResolvedValue(true);
    const cfg = asConfig({
      channels: {
        zalouser: {
          accounts: {
            default: { enabled: true },
            work: { enabled: false },
          },
        },
      },
    });

    const accounts = await listEnabledZalouserAccounts(cfg);
    expect(accounts.map((account) => account.accountId)).toEqual(["default"]);
  });

  it("maps account info helper from zalo-js", async () => {
    mockGetUserInfo.mockResolvedValueOnce({
      userId: "123",
      displayName: "Alice",
      avatar: "https://example.com/avatar.png",
    });
    expect(await getZcaUserInfo("default")).toEqual({
      userId: "123",
      displayName: "Alice",
    });

    mockGetUserInfo.mockResolvedValueOnce(null);
    expect(await getZcaUserInfo("default")).toBeNull();
  });
});
