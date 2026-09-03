// Matrix tests cover scoped env var account token behavior.
import { describe, expect, it } from "vitest";
import { listMatrixEnvAccountIds, resolveMatrixEnvAccountToken } from "./env-vars.js";

describe("listMatrixEnvAccountIds", () => {
  it("discovers accounts whose ids need hex-escaped env tokens", () => {
    const token = resolveMatrixEnvAccountToken("team.ops");
    const env = {
      [`MATRIX_${token}_HOMESERVER`]: "https://matrix.example.org",
    } satisfies NodeJS.ProcessEnv;

    expect(listMatrixEnvAccountIds(env)).toEqual(["team-ops"]);
  });

  it("ignores scoped env vars whose account token is malformed", () => {
    const env = {
      MATRIX_TEAM_XZZ_OPS_HOMESERVER: "https://matrix.example.org",
      "MATRIX_!_HOMESERVER": "https://matrix.example.org",
    } satisfies NodeJS.ProcessEnv;

    expect(listMatrixEnvAccountIds(env)).toEqual([]);
  });

  it("ignores hex escapes above the Unicode range instead of throwing", () => {
    // String.fromCodePoint throws a RangeError for code points above 0x10FFFF;
    // a malformed MATRIX_* env var must not crash account discovery.
    const env = {
      MATRIX_A_X110000_B_HOMESERVER: "https://matrix.example.org",
      MATRIX_A_XFFFFFFFF_B_HOMESERVER: "https://matrix.example.org",
    } satisfies NodeJS.ProcessEnv;

    expect(listMatrixEnvAccountIds(env)).toEqual([]);
  });
});
