// Line tests cover accounts plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveLineAccount, resolveDefaultLineAccountId, normalizeAccountId } from "./accounts.js";

describe("LINE accounts", () => {
  const tempDirs: string[] = [];

  const createSecretFile = (fileName: string, contents: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-line-account-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, fileName);
    fs.writeFileSync(filePath, contents, "utf8");
    return filePath;
  };

  beforeEach(() => {
    vi.stubEnv("LINE_CHANNEL_ACCESS_TOKEN", "");
    vi.stubEnv("LINE_CHANNEL_SECRET", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("resolveLineAccount", () => {
    it("resolves account from config", () => {
      const cfg: OpenClawConfig = {
        channels: {
          line: {
            enabled: true,
            channelAccessToken: "test-token",
            channelSecret: "test-secret",
            name: "Test Bot",
          },
        },
      };

      const account = resolveLineAccount({ cfg });

      expect(account.accountId).toBe(DEFAULT_ACCOUNT_ID);
      expect(account.enabled).toBe(true);
      expect(account.channelAccessToken).toBe("test-token");
      expect(account.channelSecret).toBe("test-secret");
      expect(account.name).toBe("Test Bot");
      expect(account.tokenSource).toBe("config");
    });

    it("resolves account from environment variables", () => {
      vi.stubEnv("LINE_CHANNEL_ACCESS_TOKEN", "env-token");
      vi.stubEnv("LINE_CHANNEL_SECRET", "env-secret");

      const cfg: OpenClawConfig = {
        channels: {
          line: {
            enabled: true,
          },
        },
      };

      const account = resolveLineAccount({ cfg });

      expect(account.channelAccessToken).toBe("env-token");
      expect(account.channelSecret).toBe("env-secret");
      expect(account.tokenSource).toBe("env");
    });

    it("resolves named account", () => {
      const cfg: OpenClawConfig = {
        channels: {
          line: {
            enabled: true,
            accounts: {
              business: {
                enabled: true,
                channelAccessToken: "business-token",
                channelSecret: "business-secret",
                name: "Business Bot",
              },
            },
          },
        },
      };

      const account = resolveLineAccount({ cfg, accountId: "business" });

      expect(account.accountId).toBe("business");
      expect(account.enabled).toBe(true);
      expect(account.channelAccessToken).toBe("business-token");
      expect(account.channelSecret).toBe("business-secret");
      expect(account.name).toBe("Business Bot");
    });

    it("uses configured defaultAccount when accountId is omitted", () => {
      const cfg: OpenClawConfig = {
        channels: {
          line: {
            defaultAccount: "business",
            accounts: {
              business: {
                enabled: true,
                channelAccessToken: "business-token",
                channelSecret: "business-secret",
                name: "Business Bot",
              },
            },
          },
        },
      };

      const account = resolveLineAccount({ cfg });

      expect(account.accountId).toBe("business");
      expect(account.enabled).toBe(true);
      expect(account.channelAccessToken).toBe("business-token");
      expect(account.channelSecret).toBe("business-secret");
      expect(account.name).toBe("Business Bot");
    });

    it("returns empty token when not configured", () => {
      const cfg: OpenClawConfig = {};

      const account = resolveLineAccount({ cfg });

      expect(account.channelAccessToken).toBe("");
      expect(account.channelSecret).toBe("");
      expect(account.tokenSource).toBe("none");
    });

    it("resolves default account credentials from files", () => {
      const cfg: OpenClawConfig = {
        channels: {
          line: {
            tokenFile: createSecretFile("token.txt", "file-token\n"),
            secretFile: createSecretFile("secret.txt", "file-secret\n"),
          },
        },
      };

      const account = resolveLineAccount({ cfg });

      expect(account.channelAccessToken).toBe("file-token");
      expect(account.channelSecret).toBe("file-secret");
      expect(account.tokenSource).toBe("file");
    });

    it("resolves named account credentials from account-level files", () => {
      const cfg: OpenClawConfig = {
        channels: {
          line: {
            accounts: {
              business: {
                tokenFile: createSecretFile("business-token.txt", "business-file-token\n"),
                secretFile: createSecretFile("business-secret.txt", "business-file-secret\n"),
              },
            },
          },
        },
      };

      const account = resolveLineAccount({ cfg, accountId: "business" });

      expect(account.channelAccessToken).toBe("business-file-token");
      expect(account.channelSecret).toBe("business-file-secret");
      expect(account.tokenSource).toBe("file");
    });

    it.runIf(process.platform !== "win32")(
      "marks symlinked token and secret files configured-unavailable",
      () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-line-account-"));
        tempDirs.push(dir);
        const tokenFile = path.join(dir, "token.txt");
        const tokenLink = path.join(dir, "token-link.txt");
        const secretFile = path.join(dir, "secret.txt");
        const secretLink = path.join(dir, "secret-link.txt");
        fs.writeFileSync(tokenFile, "file-token\n", "utf8");
        fs.writeFileSync(secretFile, "file-secret\n", "utf8");
        fs.symlinkSync(tokenFile, tokenLink);
        fs.symlinkSync(secretFile, secretLink);

        const cfg: OpenClawConfig = {
          channels: {
            line: {
              tokenFile: tokenLink,
              secretFile: secretLink,
            },
          },
        };

        const account = resolveLineAccount({ cfg });
        expect(account.tokenStatus).toBe("configured_unavailable");
        expect(account.signingSecretStatus).toBe("configured_unavailable");
        expect(account.credentialDiagnostics).toEqual([
          {
            code: "CREDENTIAL_FILE_UNAVAILABLE",
            path: "channels.line.tokenFile",
            reason: "symlink",
          },
          {
            code: "CREDENTIAL_FILE_UNAVAILABLE",
            path: "channels.line.secretFile",
            reason: "symlink",
          },
        ]);
        expect(JSON.stringify(account.credentialDiagnostics)).not.toContain(dir);
      },
    );

    it("does not fall through when an explicit credential file is missing", () => {
      vi.stubEnv("LINE_CHANNEL_ACCESS_TOKEN", "env-token");
      vi.stubEnv("LINE_CHANNEL_SECRET", "env-secret");
      const tokenFile = createSecretFile("missing-token.txt", "unused");
      fs.rmSync(tokenFile);
      const cfg: OpenClawConfig = {
        channels: {
          line: {
            tokenFile,
            channelSecret: "test-channel-secret",
          },
        },
      };

      const account = resolveLineAccount({ cfg });

      expect(account.channelAccessToken).toBe("");
      expect(account.tokenStatus).toBe("configured_unavailable");
      expect(account.tokenSource).toBe("file");
    });

    it("resolves default account credentials from accounts.default", () => {
      const cfg: OpenClawConfig = {
        channels: {
          line: {
            enabled: true,
            accounts: {
              default: {
                channelAccessToken: "default-token",
                channelSecret: "default-secret",
                name: "Default Bot",
              },
            },
          },
        },
      };

      const account = resolveLineAccount({ cfg });

      expect(account.accountId).toBe(DEFAULT_ACCOUNT_ID);
      expect(account.enabled).toBe(true);
      expect(account.channelAccessToken).toBe("default-token");
      expect(account.channelSecret).toBe("default-secret");
      expect(account.name).toBe("Default Bot");
      expect(account.tokenSource).toBe("config");
    });

    it("prefers accounts.default credentials over top-level base credentials", () => {
      const cfg: OpenClawConfig = {
        channels: {
          line: {
            enabled: true,
            channelAccessToken: "base-token",
            channelSecret: "base-secret",
            accounts: {
              default: {
                channelAccessToken: "override-token",
                channelSecret: "override-secret",
              },
            },
          },
        },
      };

      const account = resolveLineAccount({ cfg });

      expect(account.channelAccessToken).toBe("override-token");
      expect(account.channelSecret).toBe("override-secret");
    });

    it("treats named accounts without explicit enabled as enabled", () => {
      const cfg: OpenClawConfig = {
        channels: {
          line: {
            enabled: true,
            accounts: {
              twgreen: {
                channelAccessToken: "twgreen-token",
                channelSecret: "twgreen-secret",
              },
            },
          },
        },
      };

      const account = resolveLineAccount({ cfg, accountId: "twgreen" });

      expect(account.enabled).toBe(true);
      expect(account.channelAccessToken).toBe("twgreen-token");
      expect(account.channelSecret).toBe("twgreen-secret");
    });

    it("disables a named account when channels.line.enabled is false", () => {
      const cfg: OpenClawConfig = {
        channels: {
          line: {
            enabled: false,
            accounts: {
              twgreen: {
                enabled: true,
                channelAccessToken: "twgreen-token",
                channelSecret: "twgreen-secret",
              },
            },
          },
        },
      };

      const account = resolveLineAccount({ cfg, accountId: "twgreen" });

      expect(account.enabled).toBe(false);
    });

    it("disables accounts.default when channels.line.enabled is false", () => {
      const cfg: OpenClawConfig = {
        channels: {
          line: {
            enabled: false,
            accounts: {
              default: {
                channelAccessToken: "default-token",
                channelSecret: "default-secret",
              },
            },
          },
        },
      };

      const account = resolveLineAccount({ cfg });

      expect(account.enabled).toBe(false);
    });

    it("respects explicit enabled:false on a named account", () => {
      const cfg: OpenClawConfig = {
        channels: {
          line: {
            enabled: true,
            accounts: {
              twgreen: {
                enabled: false,
                channelAccessToken: "twgreen-token",
                channelSecret: "twgreen-secret",
              },
            },
          },
        },
      };

      const account = resolveLineAccount({ cfg, accountId: "twgreen" });

      expect(account.enabled).toBe(false);
    });

    it("prefers accounts.default name over top-level channels.line.name", () => {
      const cfg: OpenClawConfig = {
        channels: {
          line: {
            enabled: true,
            name: "Top-level Bot",
            accounts: {
              default: {
                channelAccessToken: "default-token",
                channelSecret: "default-secret",
                name: "Default Account Bot",
              },
            },
          },
        },
      };

      const account = resolveLineAccount({ cfg });

      expect(account.name).toBe("Default Account Bot");
    });
  });

  describe("resolveDefaultLineAccountId", () => {
    it.each([
      {
        name: "prefers channels.line.defaultAccount when configured",
        cfg: {
          channels: {
            line: {
              defaultAccount: "business",
              accounts: {
                business: { enabled: true },
                support: { enabled: true },
              },
            },
          },
        } satisfies OpenClawConfig,
        expected: "business",
      },
      {
        name: "normalizes channels.line.defaultAccount before lookup",
        cfg: {
          channels: {
            line: {
              defaultAccount: "Business Ops",
              accounts: {
                "business-ops": { enabled: true },
              },
            },
          },
        } satisfies OpenClawConfig,
        expected: "business-ops",
      },
      {
        name: "returns first named account when default not configured",
        cfg: {
          channels: {
            line: {
              accounts: {
                business: { enabled: true },
              },
            },
          },
        } satisfies OpenClawConfig,
        expected: "business",
      },
      {
        name: "falls back when channels.line.defaultAccount is missing",
        cfg: {
          channels: {
            line: {
              defaultAccount: "missing",
              accounts: {
                business: { enabled: true },
              },
            },
          },
        } satisfies OpenClawConfig,
        expected: "business",
      },
      {
        name: "prefers the default account when base credentials are configured",
        cfg: {
          channels: {
            line: {
              channelAccessToken: "base-token",
              accounts: {
                business: { enabled: true },
              },
            },
          },
        } satisfies OpenClawConfig,
        expected: DEFAULT_ACCOUNT_ID,
      },
    ])("$name", ({ cfg, expected }) => {
      expect(resolveDefaultLineAccountId(cfg)).toBe(expected);
    });
  });

  describe("normalizeAccountId", () => {
    it("trims and lowercases account ids", () => {
      expect(normalizeAccountId("  Business  ")).toBe("business");
    });
  });
});
