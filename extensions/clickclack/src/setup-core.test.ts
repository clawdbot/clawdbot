// ClickClack tests cover non-interactive setup validation and config writes.
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createNonExitingRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const claimClickClackSetupCode = vi.hoisted(() => vi.fn());
const verifyClickClackAccountAfterSetup = vi.hoisted(() => vi.fn());

vi.mock("./setup-claim.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./setup-claim.js")>()),
  claimClickClackSetupCode,
}));
vi.mock("./setup-verify.js", () => ({
  verifyClickClackAccountAfterSetup,
}));
import {
  applyClickClackCredentialConfig,
  clickClackSetupAdapter,
  normalizeClickClackBaseUrl,
} from "./setup-core.js";

// Structural stand-in for the internal claim error: the setup formatter
// duck-types on a numeric `status`, so tests need only that shape.
function makeClaimError(status: number, detail: string): Error {
  return Object.assign(new Error(`claim failed (${status}): ${detail}`), { status });
}

function validate(params: {
  cfg?: OpenClawConfig;
  accountId?: string;
  input: Parameters<NonNullable<typeof clickClackSetupAdapter.validateInput>>[0]["input"];
}) {
  return clickClackSetupAdapter.validateInput?.({
    cfg: params.cfg ?? {},
    accountId: params.accountId ?? DEFAULT_ACCOUNT_ID,
    input: params.input,
  });
}

async function prepare(
  input: Parameters<
    NonNullable<typeof clickClackSetupAdapter.prepareAccountConfigInput>
  >[0]["input"],
  cfg: OpenClawConfig = {},
) {
  return await clickClackSetupAdapter.prepareAccountConfigInput?.({
    cfg,
    accountId: DEFAULT_ACCOUNT_ID,
    input,
    runtime: createNonExitingRuntimeEnv(),
  });
}

describe("ClickClack setup adapter", () => {
  beforeEach(() => {
    claimClickClackSetupCode.mockReset();
  });

  it("normalizes http(s) base URLs and rejects other schemes", () => {
    expect(normalizeClickClackBaseUrl(" https://clickclack.example.com/// ")).toBe(
      "https://clickclack.example.com",
    );
    expect(normalizeClickClackBaseUrl("http://localhost:3000/")).toBe("http://localhost:3000");
    expect(normalizeClickClackBaseUrl("ssh://clickclack.example.com")).toBeUndefined();
    expect(normalizeClickClackBaseUrl("not-a-url")).toBeUndefined();
  });

  it("claims a full setup URL and prepares the token, workspace, and defaults", async () => {
    claimClickClackSetupCode.mockResolvedValue({
      token: "test-token",
      bot: { id: "usr_bot", handle: "openclaw", display_name: "OpenClaw" },
      workspace: {
        id: "wsp_1",
        route_id: "clickclack",
        slug: "default",
        name: "ClickClack",
      },
      defaults: {
        defaultTo: "channel:general",
        allowFrom: ["*"],
        agentActivity: true,
      },
    });

    await expect(
      prepare({
        code: "https://clickclack.example/#abcd-efgh-jkmn",
        name: "Primary",
      }),
    ).resolves.toEqual({
      name: "Primary",
      baseUrl: "https://clickclack.example",
      token: "test-token",
      workspace: "wsp_1",
      defaultTo: "channel:general",
      allowFrom: ["*"],
      agentActivity: true,
    });
    expect(claimClickClackSetupCode).toHaveBeenCalledWith({
      claimUrl: "https://clickclack.example/api/bot-setup-codes/claim",
      code: "ABCDEFGHJKMN",
    });
  });

  it("claims an exact v1 endpoint and keeps the returned API base path", async () => {
    claimClickClackSetupCode.mockResolvedValue({
      contract_version: 1,
      api_base_url: "https://api.clickclack.example/services/clickclack",
      token: "test-token",
      bot: { id: "usr_bot", handle: "openclaw", display_name: "OpenClaw" },
      workspace: {
        id: "wsp_1",
        route_id: "clickclack",
        slug: "default",
        name: "ClickClack",
      },
      defaults: {},
    });

    const exactClaimUrl =
      "https://api.clickclack.example/services/clickclack/api/bot-setup-codes/claim";
    await expect(
      prepare({
        code: `${exactClaimUrl}#abcd-efgh-jkmn`,
      }),
    ).resolves.toMatchObject({
      baseUrl: "https://api.clickclack.example/services/clickclack",
      token: "test-token",
      workspace: "wsp_1",
    });
    expect(claimClickClackSetupCode).toHaveBeenCalledWith({
      claimUrl: exactClaimUrl,
      expectedClaimUrl: exactClaimUrl,
      code: "ABCDEFGHJKMN",
    });
  });

  it("claims a bare setup code with an explicit HTTPS base URL", async () => {
    claimClickClackSetupCode.mockResolvedValue({
      token: "test-token",
      bot: { id: "usr_bot", handle: "openclaw", display_name: "OpenClaw" },
      workspace: {
        id: "wsp_1",
        route_id: "clickclack",
        slug: "default",
        name: "ClickClack",
      },
      defaults: {},
    });

    await expect(
      prepare({
        code: "abcd efgh jkmn",
        baseUrl: "https://clickclack.example/",
      }),
    ).resolves.toMatchObject({
      baseUrl: "https://clickclack.example",
      token: "test-token",
      workspace: "wsp_1",
    });
    expect(claimClickClackSetupCode).toHaveBeenCalledWith({
      claimUrl: "https://clickclack.example/api/bot-setup-codes/claim",
      code: "ABCDEFGHJKMN",
    });
  });

  it("claims setup codes through an existing private API base", async () => {
    claimClickClackSetupCode.mockResolvedValue({
      token: "test-token",
      bot: { id: "usr_bot", handle: "openclaw", display_name: "OpenClaw" },
      workspace: {
        id: "wsp_1",
        route_id: "clickclack",
        slug: "default",
        name: "ClickClack",
      },
      defaults: {},
    });

    await prepare(
      {
        code: "ABCD-EFGH-JKMN",
        baseUrl: "https://clack.openclaw.ai",
      },
      {
        channels: {
          clickclack: {
            apiBaseUrl: "http://127.0.0.1:8484",
          },
        },
      } as OpenClawConfig,
    );

    expect(claimClickClackSetupCode).toHaveBeenCalledWith({
      claimUrl: "http://127.0.0.1:8484/api/bot-setup-codes/claim",
      code: "ABCDEFGHJKMN",
    });
  });

  it("uses a private API transport while validating the public exact endpoint", async () => {
    claimClickClackSetupCode.mockResolvedValue({
      contract_version: 1,
      api_base_url: "https://api.clickclack.example/services/clickclack",
      token: "test-token",
      bot: { id: "usr_bot", handle: "openclaw", display_name: "OpenClaw" },
      workspace: {
        id: "wsp_1",
        route_id: "clickclack",
        slug: "default",
        name: "ClickClack",
      },
      defaults: {},
    });

    const exactClaimUrl =
      "https://api.clickclack.example/services/clickclack/api/bot-setup-codes/claim";
    await expect(
      prepare({ code: `${exactClaimUrl}#ABCD-EFGH-JKMN` }, {
        channels: {
          clickclack: {
            apiBaseUrl: "http://127.0.0.1:8484",
          },
        },
      } as OpenClawConfig),
    ).resolves.toMatchObject({
      baseUrl: "https://api.clickclack.example/services/clickclack",
    });
    expect(claimClickClackSetupCode).toHaveBeenCalledWith({
      claimUrl: "http://127.0.0.1:8484/api/bot-setup-codes/claim",
      expectedClaimUrl: exactClaimUrl,
      code: "ABCDEFGHJKMN",
    });
  });

  it("accepts setup-code URLs for local HTTP installations", async () => {
    claimClickClackSetupCode.mockResolvedValue({
      token: "test-token",
      bot: { id: "usr_bot", handle: "openclaw", display_name: "OpenClaw" },
      workspace: {
        id: "wsp_1",
        route_id: "clickclack",
        slug: "default",
        name: "ClickClack",
      },
      defaults: {},
    });

    await expect(
      prepare({
        code: "http://localhost:3000/#abcd-efgh-jkmn",
      }),
    ).resolves.toMatchObject({
      baseUrl: "http://localhost:3000",
      token: "test-token",
      workspace: "wsp_1",
    });
    expect(claimClickClackSetupCode).toHaveBeenCalledWith({
      claimUrl: "http://localhost:3000/api/bot-setup-codes/claim",
      code: "ABCDEFGHJKMN",
    });
  });

  it("rejects conflicting credentials before claiming a setup code", async () => {
    for (const input of [
      { code: "ABCD-EFGH-JKMN", baseUrl: "https://clickclack.example", token: "test-token" },
      {
        code: "ABCD-EFGH-JKMN",
        baseUrl: "https://clickclack.example",
        tokenFile: "test-token-file",
      },
      { code: "ABCD-EFGH-JKMN", baseUrl: "https://clickclack.example", useEnv: true },
    ]) {
      await expect(prepare(input)).rejects.toThrow(
        "ClickClack --code cannot be combined with --token, --token-file, or --use-env.",
      );
    }
    expect(claimClickClackSetupCode).not.toHaveBeenCalled();
  });

  it("rejects mismatched and malformed setup-code inputs before claiming", async () => {
    await expect(prepare({ code: "ftp://clickclack.example/#ABCD-EFGH-JKMN" })).rejects.toThrow(
      "HTTP(S)",
    );
    await expect(
      prepare({
        code: "https://clickclack.example/#ABCD-EFGH-JKMN",
        baseUrl: "https://other.example",
      }),
    ).rejects.toThrow("does not match");
    await expect(
      prepare({ code: "not-a-code", baseUrl: "https://clickclack.example" }),
    ).rejects.toThrow("12 valid base32 characters");
    await expect(
      prepare({
        code: "https://clickclack.example/?next=api#ABCD-EFGH-JKMN",
      }),
    ).rejects.toThrow("must not include a query");
    await expect(
      prepare({
        code:
          "https://api.clickclack.example/services/clickclack/api/bot-setup-codes/claim" +
          "#ABCD-EFGH-JKMN",
        baseUrl: "https://api.clickclack.example",
      }),
    ).rejects.toThrow("does not match");
    expect(claimClickClackSetupCode).not.toHaveBeenCalled();
  });

  it("maps invalid and rate-limited claims to actionable errors", async () => {
    claimClickClackSetupCode.mockRejectedValueOnce(makeClaimError(404, "not found"));
    await expect(
      prepare({ code: "ABCD-EFGH-JKMN", baseUrl: "https://clickclack.example" }),
    ).rejects.toThrow("invalid, expired, or already used");

    claimClickClackSetupCode.mockRejectedValueOnce(makeClaimError(429, "retry later"));
    await expect(
      prepare({ code: "ABCD-EFGH-JKMN", baseUrl: "https://clickclack.example" }),
    ).rejects.toThrow("Too many ClickClack setup code attempts");
  });

  it("writes setup-code defaults through the existing account patch", () => {
    expect(
      clickClackSetupAdapter.applyAccountConfig({
        cfg: {},
        accountId: DEFAULT_ACCOUNT_ID,
        input: {
          token: "test-token",
          baseUrl: "https://clickclack.example",
          workspace: "wsp_1",
          defaultTo: " channel:general ",
          allowFrom: ["*"],
          agentActivity: true,
        },
      }),
    ).toEqual({
      channels: {
        clickclack: {
          enabled: true,
          token: "test-token",
          baseUrl: "https://clickclack.example",
          workspace: "wsp_1",
          defaultTo: "channel:general",
          allowFrom: ["*"],
          agentActivity: true,
        },
      },
    });
  });

  it("requires token, base URL, and workspace for explicit setup", () => {
    const message = "ClickClack requires --token, --base-url, and --workspace (or --use-env).";
    expect(
      validate({ input: { baseUrl: "https://clickclack.example", workspace: "default" } }),
    ).toBe(message);
    expect(validate({ input: { token: "ccb_test", workspace: "default" } })).toBe(message);
    expect(validate({ input: { token: "ccb_test", baseUrl: "https://clickclack.example" } })).toBe(
      message,
    );
    expect(
      validate({
        input: {
          token: "ccb_test",
          baseUrl: "https://clickclack.example",
          workspace: "default",
        },
      }),
    ).toBeNull();
  });

  it("limits --use-env to the default account and requires URL and workspace config", () => {
    expect(
      validate({
        accountId: "work",
        input: {
          useEnv: true,
          baseUrl: "https://clickclack.example",
          workspace: "default",
        },
      }),
    ).toBe("CLICKCLACK_BOT_TOKEN can only be used for the default account.");
    expect(validate({ input: { useEnv: true } })).toBe(
      "ClickClack requires --token, --base-url, and --workspace (or --use-env).",
    );
    expect(
      validate({
        cfg: {
          channels: {
            clickclack: {
              baseUrl: "https://clickclack.example",
              workspace: "default",
            },
          },
        } as OpenClawConfig,
        input: { useEnv: true },
      }),
    ).toBeNull();
    expect(
      validate({
        cfg: {
          channels: {
            clickclack: {
              baseUrl: "ssh://clickclack.example",
              workspace: "default",
            },
          },
        } as OpenClawConfig,
        input: { useEnv: true },
      }),
    ).toBe("ClickClack base URL must be a valid http(s) URL.");
  });

  it("rejects malformed base URLs before writing config", () => {
    expect(
      validate({
        input: {
          token: "ccb_test",
          baseUrl: "clickclack.example",
          workspace: "default",
        },
      }),
    ).toBe("ClickClack base URL must be a valid http(s) URL.");
  });

  it("writes normalized default and named account config", () => {
    expect(
      clickClackSetupAdapter.applyAccountConfig({
        cfg: {},
        accountId: DEFAULT_ACCOUNT_ID,
        input: {
          name: "Primary",
          token: "ccb_default",
          baseUrl: "https://clickclack.example/",
          workspace: " default ",
        },
      }),
    ).toEqual({
      channels: {
        clickclack: {
          enabled: true,
          name: "Primary",
          token: "ccb_default",
          baseUrl: "https://clickclack.example",
          workspace: "default",
        },
      },
    });

    expect(
      clickClackSetupAdapter.applyAccountConfig({
        cfg: { channels: { clickclack: { name: "Legacy" } } } as OpenClawConfig,
        accountId: "Work Team",
        input: {
          name: "Work",
          tokenFile: "/run/secrets/clickclack",
          baseUrl: "https://work.clickclack.example/",
          workspace: "wsp_work",
        },
      }),
    ).toEqual({
      channels: {
        clickclack: {
          enabled: true,
          accounts: {
            default: { name: "Legacy" },
            "work-team": {
              enabled: true,
              name: "Work",
              tokenFile: "/run/secrets/clickclack",
              baseUrl: "https://work.clickclack.example",
              workspace: "wsp_work",
            },
          },
        },
      },
    });
  });

  it("keeps --use-env config free of token fields", () => {
    expect(
      clickClackSetupAdapter.applyAccountConfig({
        cfg: {},
        accountId: DEFAULT_ACCOUNT_ID,
        input: {
          useEnv: true,
          baseUrl: "https://clickclack.example/",
          workspace: "default",
        },
      }),
    ).toEqual({
      channels: {
        clickclack: {
          enabled: true,
          baseUrl: "https://clickclack.example",
          workspace: "default",
        },
      },
    });
  });

  it("clears stale competing credentials when the auth mode changes", () => {
    const base = {
      channels: {
        clickclack: {
          baseUrl: "https://clickclack.example",
          workspace: "default",
        },
      },
    } as OpenClawConfig;

    const withToken = clickClackSetupAdapter.applyAccountConfig({
      cfg: {
        channels: {
          clickclack: {
            ...base.channels?.clickclack,
            tokenFile: "/run/secrets/old-token",
          },
        },
      } as OpenClawConfig,
      accountId: DEFAULT_ACCOUNT_ID,
      input: {
        token: "ccb_new",
        baseUrl: "https://clickclack.example",
        workspace: "default",
      },
    });
    expect(withToken.channels?.clickclack).toMatchObject({ token: "ccb_new" });
    expect(withToken.channels?.clickclack).not.toHaveProperty("tokenFile");

    const withFile = clickClackSetupAdapter.applyAccountConfig({
      cfg: {
        channels: {
          clickclack: {
            ...base.channels?.clickclack,
            token: "ccb_old",
          },
        },
      } as OpenClawConfig,
      accountId: DEFAULT_ACCOUNT_ID,
      input: {
        tokenFile: "/run/secrets/new-token",
        baseUrl: "https://clickclack.example",
        workspace: "default",
      },
    });
    expect(withFile.channels?.clickclack).toMatchObject({
      tokenFile: "/run/secrets/new-token",
    });
    expect(withFile.channels?.clickclack).not.toHaveProperty("token");

    const withEnv = clickClackSetupAdapter.applyAccountConfig({
      cfg: {
        channels: {
          clickclack: {
            baseUrl: "https://clickclack.example/",
            workspace: " default ",
            token: "ccb_old",
            tokenFile: "/run/secrets/old-token",
          },
        },
      } as OpenClawConfig,
      accountId: DEFAULT_ACCOUNT_ID,
      input: { useEnv: true },
    });
    expect(withEnv.channels?.clickclack).not.toHaveProperty("token");
    expect(withEnv.channels?.clickclack).not.toHaveProperty("tokenFile");
    expect(withEnv.channels?.clickclack).toMatchObject({
      baseUrl: "https://clickclack.example",
      workspace: "default",
    });

    const namedWithToken = clickClackSetupAdapter.applyAccountConfig({
      cfg: {
        channels: {
          clickclack: {
            baseUrl: "https://clickclack.example",
            workspace: "default",
            tokenFile: "/run/secrets/default-token",
          },
        },
      } as OpenClawConfig,
      accountId: "work",
      input: {
        token: "ccb_work",
        baseUrl: "https://clickclack.example",
        workspace: "work",
      },
    });
    expect(namedWithToken.channels?.clickclack).not.toHaveProperty("tokenFile");
    expect(namedWithToken.channels?.clickclack?.accounts).toMatchObject({
      default: { tokenFile: "/run/secrets/default-token" },
      work: { token: "ccb_work" },
    });
    expect(namedWithToken.channels?.clickclack?.accounts?.work).not.toHaveProperty("tokenFile");
  });

  it("preserves credentials when a partial patch does not select an auth mode", () => {
    const cfg = {
      channels: {
        clickclack: {
          tokenFile: "/run/secrets/clickclack",
        },
      },
    } as OpenClawConfig;

    expect(
      applyClickClackCredentialConfig({
        cfg,
        accountId: DEFAULT_ACCOUNT_ID,
      }).channels?.clickclack,
    ).toMatchObject({
      enabled: true,
      tokenFile: "/run/secrets/clickclack",
    });
  });

  it("runs post-write verification with the saved account config", async () => {
    const cfg = {
      channels: {
        clickclack: {
          baseUrl: "https://clickclack.example",
          token: "ccb_test",
          workspace: "default",
        },
      },
    } as OpenClawConfig;
    const runtime = createNonExitingRuntimeEnv();

    await clickClackSetupAdapter.afterAccountConfigWritten?.({
      previousCfg: {},
      cfg,
      accountId: DEFAULT_ACCOUNT_ID,
      input: {},
      runtime,
    });

    expect(verifyClickClackAccountAfterSetup).toHaveBeenCalledWith({
      cfg,
      accountId: DEFAULT_ACCOUNT_ID,
      runtime,
    });
  });
});
