import { describe, expect, it } from "vitest";
import { refreshOAuthCredentialForRuntime, type OAuthCredential } from "./agent-runtime.js";

describe("agent-runtime OAuth compatibility", () => {
  it("retains the shipped direct-refresh call shape", () => {
    const credential: OAuthCredential = {
      type: "oauth",
      provider: "contract-provider",
      access: "access",
      refresh: "refresh",
      expires: 1,
    };
    const params = {
      credential,
      cfg: {},
    } satisfies Parameters<typeof refreshOAuthCredentialForRuntime>[0];

    expect(params).toEqual({ credential, cfg: {} });
    expect(refreshOAuthCredentialForRuntime).toBeTypeOf("function");
  });
});
