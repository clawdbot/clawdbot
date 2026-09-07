// Zalo tests cover token plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveZaloToken } from "./token.js";
import type { ZaloConfig } from "./types.js";

function createSymlinkedFile(targetPath: string, linkPath: string): boolean {
  try {
    fs.writeFileSync(targetPath, "file-token\n", "utf8");
    fs.symlinkSync(targetPath, linkPath, "file");
    return true;
  } catch {
    fs.rmSync(linkPath, { force: true });
    fs.rmSync(targetPath, { force: true });
    return false;
  }
}

describe("resolveZaloToken", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("falls back to top-level token for non-default accounts without overrides", () => {
    const cfg = {
      botToken: "top-level-token",
      accounts: {
        work: {},
      },
    } as ZaloConfig;
    const res = resolveZaloToken(cfg, "work");
    expect(res.token).toBe("top-level-token");
    expect(res.source).toBe("config");
  });

  it("uses accounts.default botToken for default account when configured", () => {
    const cfg = {
      botToken: "top-level-token",
      accounts: {
        default: {
          botToken: "default-account-token",
        },
      },
    } as ZaloConfig;
    const res = resolveZaloToken(cfg, "default");
    expect(res.token).toBe("default-account-token");
    expect(res.source).toBe("config");
  });

  it("uses configured defaultAccount token when accountId is omitted", () => {
    const cfg = {
      defaultAccount: "work",
      botToken: "top-level-token",
      accounts: {
        work: {
          botToken: "work-token",
        },
      },
    } as ZaloConfig;
    const res = resolveZaloToken(cfg);
    expect(res.token).toBe("work-token");
    expect(res.source).toBe("config");
  });

  it("does not inherit top-level token when account token is explicitly blank", () => {
    const cfg = {
      botToken: "top-level-token",
      accounts: {
        work: {
          botToken: "",
        },
      },
    } as ZaloConfig;
    const res = resolveZaloToken(cfg, "work");
    expect(res.token).toBe("");
    expect(res.source).toBe("none");
  });

  it("resolves account token when account key casing differs from normalized id", () => {
    const cfg = {
      accounts: {
        Work: {
          botToken: "work-token",
        },
      },
    } as ZaloConfig;
    const res = resolveZaloToken(cfg, "work");
    expect(res.token).toBe("work-token");
    expect(res.source).toBe("config");
  });

  it("does not fall back from an unavailable top-level token file to the environment", () => {
    const tokenFile = "/private/zalo-missing-root-token";
    vi.stubEnv("ZALO_BOT_TOKEN", "lower-priority-env-token");

    const result = resolveZaloToken({ tokenFile });

    expect(result).toMatchObject({
      token: "",
      source: "configFile",
      status: "configured_unavailable",
      credentialDiagnostics: [
        {
          code: "CREDENTIAL_FILE_UNAVAILABLE",
          path: "channels.zalo.tokenFile",
          reason: "not-found",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(tokenFile);
  });

  it("does not inherit a top-level token when an account token file is unavailable", () => {
    const tokenFile = "/private/zalo-missing-work-token";
    const result = resolveZaloToken(
      {
        botToken: "lower-priority-top-level-token",
        accounts: { work: { tokenFile } },
      },
      "work",
    );

    expect(result).toMatchObject({
      token: "",
      source: "configFile",
      status: "configured_unavailable",
      credentialDiagnostics: [
        {
          code: "CREDENTIAL_FILE_UNAVAILABLE",
          path: "channels.zalo.accounts.work.tokenFile",
          reason: "not-found",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(tokenFile);
  });

  it("honors an unavailable account token file after an explicitly blank account bot token", () => {
    const result = resolveZaloToken(
      {
        botToken: "lower-priority-top-level-token",
        accounts: { work: { botToken: "", tokenFile: "/private/zalo-blank-account-token" } },
      },
      "work",
    );

    expect(result).toMatchObject({
      token: "",
      source: "configFile",
      status: "configured_unavailable",
      credentialDiagnostics: [
        { code: "CREDENTIAL_FILE_UNAVAILABLE", path: "channels.zalo.accounts.work.tokenFile" },
      ],
    });
  });

  it("rejects symlinked token files", ({ skip }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-zalo-token-"));
    try {
      const tokenFile = path.join(dir, "token.txt");
      const tokenLink = path.join(dir, "token-link.txt");
      if (!createSymlinkedFile(tokenFile, tokenLink)) {
        skip("file symlinks are unavailable on this host");
      }

      const cfg = {
        tokenFile: tokenLink,
      } as ZaloConfig;
      const result = resolveZaloToken(cfg);
      expect(result).toMatchObject({
        token: "",
        source: "configFile",
        status: "configured_unavailable",
        credentialDiagnostics: [
          {
            code: "CREDENTIAL_FILE_UNAVAILABLE",
            path: "channels.zalo.tokenFile",
            reason: "symlink",
          },
        ],
      });
      expect(JSON.stringify(result)).not.toContain(tokenLink);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
