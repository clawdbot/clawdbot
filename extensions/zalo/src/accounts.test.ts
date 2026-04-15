import { describe, expect, it } from "vitest";
import { resolveZaloAccount } from "./accounts.js";

describe("resolveZaloAccount", () => {
  it("resolves account config when account key casing differs from normalized id", () => {
    const resolved = resolveZaloAccount({
      cfg: {
        channels: {
          zalo: {
            webhookUrl: "https://top.example.com",
            accounts: {
              Work: {
                name: "Work",
                webhookUrl: "https://work.example.com",
              },
            },
          },
        },
      },
      accountId: "work",
    });

    expect(resolved.accountId).toBe("work");
    expect(resolved.name).toBe("Work");
    expect(resolved.config.webhookUrl).toBe("https://work.example.com");
  });

  it("falls back to top-level config for named accounts without overrides", () => {
    const resolved = resolveZaloAccount({
      cfg: {
        channels: {
          zalo: {
            enabled: true,
            webhookUrl: "https://top.example.com",
            accounts: {
              work: {},
            },
          },
        },
      },
      accountId: "work",
    });

    expect(resolved.accountId).toBe("work");
    expect(resolved.enabled).toBe(true);
    expect(resolved.config.webhookUrl).toBe("https://top.example.com");
  });

  it("uses configured defaultAccount when accountId is omitted", () => {
    const resolved = resolveZaloAccount({
      cfg: {
        channels: {
          zalo: {
            defaultAccount: "work",
            accounts: {
              work: {
                name: "Work",
                botToken: "work-token",
              },
            },
          },
        },
      },
    });

    expect(resolved.accountId).toBe("work");
    expect(resolved.name).toBe("Work");
    expect(resolved.token).toBe("work-token");
  });
});
