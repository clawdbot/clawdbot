// Tlon tests cover non-interactive setup validation and config writes.
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createNonExitingRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import { tlonSetupAdapter } from "./setup-core.js";

const validInput = {
  ship: "~sampel-palnet",
  url: "https://urbit.example.com",
  code: "test-code",
};
const urlWithCredentials = new URL(validInput.url);
urlWithCredentials.username = "test-user";
urlWithCredentials.password = "test-password";

function validate(params: {
  cfg?: OpenClawConfig;
  input: Parameters<NonNullable<typeof tlonSetupAdapter.validateInput>>[0]["input"];
}) {
  return tlonSetupAdapter.validateInput?.({
    cfg: params.cfg ?? {},
    accountId: DEFAULT_ACCOUNT_ID,
    input: params.input,
  });
}

async function prepare(
  input: Parameters<NonNullable<typeof tlonSetupAdapter.prepareAccountConfigInput>>[0]["input"],
  cfg: OpenClawConfig = {},
) {
  return await tlonSetupAdapter.prepareAccountConfigInput!({
    cfg,
    accountId: DEFAULT_ACCOUNT_ID,
    input,
    runtime: createNonExitingRuntimeEnv(),
  });
}

describe("Tlon setup adapter", () => {
  it.each([
    ["file:///etc/passwd", "Invalid URL: URL must use http:// or https://"],
    ["ftp://urbit.example.com", "Invalid URL: URL must use http:// or https://"],
    [urlWithCredentials.href, "Invalid URL: URL must not include credentials"],
    ["https://", "Invalid URL: Invalid URL"],
    ["", "Tlon requires --url."],
  ])("rejects a URL the runtime cannot use: %s", (url, expected) => {
    expect(validate({ input: { ...validInput, url } })).toBe(expected);
  });

  it("accepts the same bare-host and path URL forms as the runtime", () => {
    expect(
      validate({ input: { ...validInput, url: "urbit.example.com/~/login?redirect=1" } }),
    ).toBe(null);
  });

  it("validates a config-resolved URL without rewriting it for a code-only update", async () => {
    const existingUrl = "urbit.example.com/~/login?redirect=1";
    const cfg = {
      channels: {
        tlon: { ...validInput, url: existingUrl },
      },
    } as OpenClawConfig;
    const codeOnlyInput = { code: "replacement-code" };

    expect(validate({ cfg, input: codeOnlyInput })).toBeNull();
    const prepared = await prepare(codeOnlyInput, cfg);
    expect(prepared).toEqual(codeOnlyInput);

    const next = tlonSetupAdapter.applyAccountConfig({
      cfg,
      accountId: DEFAULT_ACCOUNT_ID,
      input: prepared,
    });
    expect(next.channels?.tlon).toMatchObject({
      url: existingUrl,
      code: "replacement-code",
    });
    expect(validate({ cfg, input: { ...codeOnlyInput, url: "   " } })).toBe("Tlon requires --url.");

    expect(
      validate({
        cfg: {
          channels: { tlon: { ...validInput, url: "ftp://urbit.example.com" } },
        } as OpenClawConfig,
        input: { code: "replacement-code" },
      }),
    ).toBe("Invalid URL: URL must use http:// or https://");
  });

  it("normalizes an explicit URL before the adapter writes config", async () => {
    const input = await prepare({
      ...validInput,
      url: " urbit.example.com/~/login?redirect=1 ",
    });
    expect(input?.url).toBe("https://urbit.example.com");

    const cfg = tlonSetupAdapter.applyAccountConfig({
      cfg: {},
      accountId: DEFAULT_ACCOUNT_ID,
      input,
    });
    expect(cfg.channels?.tlon?.url).toBe("https://urbit.example.com");
  });
});
