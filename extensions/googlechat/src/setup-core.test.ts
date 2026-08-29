import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import { googlechatSetupAdapter } from "./setup-core.js";

type GoogleChatChannelConfig = {
  serviceAccount?: string;
  serviceAccountFile?: string;
};

function applyGoogleChatSetup(
  input: Record<string, unknown>,
  cfg: OpenClawConfig = {} as OpenClawConfig,
): OpenClawConfig {
  return googlechatSetupAdapter.applyAccountConfig({ cfg, accountId: "default", input });
}

function appliedGoogleChatConfig(
  input: Record<string, unknown>,
  cfg?: OpenClawConfig,
): GoogleChatChannelConfig {
  return (applyGoogleChatSetup(input, cfg).channels?.googlechat ?? {}) as GoogleChatChannelConfig;
}

describe("googlechat credential rotation", () => {
  // Inline serviceAccount wins over serviceAccountFile at resolution time, so a
  // rotation that leaves it behind silently keeps using the credential — and its
  // plaintext private key — that it was meant to replace.
  it("retires an inline service account when a file replaces it", () => {
    const fromInline = applyGoogleChatSetup({ token: '{"type":"service_account"}' });

    const rotated = appliedGoogleChatConfig(
      { tokenFile: "/run/secrets/googlechat-sa.json" },
      fromInline,
    );

    expect(rotated.serviceAccountFile).toBe("/run/secrets/googlechat-sa.json");
    expect(rotated.serviceAccount).toBeUndefined();
  });

  it("retires a service account file when an inline value replaces it", () => {
    const fromFile = applyGoogleChatSetup({ tokenFile: "/run/secrets/googlechat-sa.json" });

    const rotated = appliedGoogleChatConfig({ token: '{"type":"service_account"}' }, fromFile);

    expect(rotated.serviceAccount).toBe('{"type":"service_account"}');
    expect(rotated.serviceAccountFile).toBeUndefined();
  });

  it("retires both sources when switching to the environment", () => {
    const fromInline = applyGoogleChatSetup({ token: '{"type":"service_account"}' });

    const rotated = appliedGoogleChatConfig({ useEnv: true }, fromInline);

    expect(rotated.serviceAccount).toBeUndefined();
    expect(rotated.serviceAccountFile).toBeUndefined();
  });
});
