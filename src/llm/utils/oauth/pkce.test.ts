import { describe, expect, it } from "vitest";
import { generateOAuthState, generatePKCE } from "./pkce.js";

describe("OAuth PKCE utilities", () => {
  it("generates OAuth state independently from the PKCE verifier", async () => {
    const { verifier } = await generatePKCE();
    const state = generateOAuthState();
    const nextState = generateOAuthState();

    expect(state).toHaveLength(43);
    expect(state).not.toBe(verifier);
    expect(nextState).toHaveLength(43);
    expect(nextState).not.toBe(state);
  });
});
