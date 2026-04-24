import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { patchCodexAuthForCi, prepareCodexCiAuth } from "../../scripts/prepare-codex-ci-auth.ts";
import { withTempDir } from "../test-utils/temp-dir.js";

function encodeJwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none" }), "utf-8").toString("base64url"),
    Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url"),
    "",
  ].join(".");
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  if (!payload) {
    throw new Error("missing payload");
  }
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")) as Record<string, unknown>;
}

describe("prepare-codex-ci-auth", () => {
  it("copies tokens.account_id into id_token chatgpt_account_id", () => {
    const idToken = encodeJwt({ email: "peter@example.com" });

    const result = patchCodexAuthForCi({
      tokens: {
        account_id: "acct_123",
        id_token: idToken,
      },
    });

    expect(result.changed).toBe(true);
    expect(decodeJwtPayload(String(result.auth.tokens?.id_token))).toMatchObject({
      email: "peter@example.com",
      chatgpt_account_id: "acct_123",
    });
  });

  it("leaves current auth metadata unchanged", () => {
    const idToken = encodeJwt({ chatgpt_account_id: "acct_existing" });

    expect(
      patchCodexAuthForCi({
        tokens: {
          account_id: "acct_123",
          id_token: idToken,
        },
      }),
    ).toEqual({
      auth: {
        tokens: {
          account_id: "acct_123",
          id_token: idToken,
        },
      },
      changed: false,
    });
  });

  it("writes only the staged auth file", async () => {
    await withTempDir("codex-ci-auth-", async (tempDir) => {
      const authPath = path.join(tempDir, "auth.json");
      await fs.writeFile(
        authPath,
        JSON.stringify({
          tokens: {
            account_id: "acct_123",
            id_token: encodeJwt({ sub: "user" }),
          },
        }),
      );

      await expect(prepareCodexCiAuth(authPath)).resolves.toBe(true);

      const updated = JSON.parse(await fs.readFile(authPath, "utf-8")) as {
        tokens?: { id_token?: string };
      };
      expect(decodeJwtPayload(String(updated.tokens?.id_token))).toMatchObject({
        sub: "user",
        chatgpt_account_id: "acct_123",
      });
    });
  });
});
