/** Tests retained external CLI credential readers. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  readGeminiCliCredentialsCached,
  readMiniMaxCliCredentialsCached,
} from "./cli-credentials.js";

function writeCredential(relativePath: string, value: Record<string, unknown>): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-credentials-"));
  const filePath = path.join(home, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, JSON.stringify(value), "utf8");
  return home;
}

describe("retained external CLI credentials", () => {
  it("reads MiniMax OAuth from its provider-owned file", () => {
    const home = writeCredential(".minimax/oauth_creds.json", {
      access_token: "minimax-access",
      refresh_token: "minimax-refresh",
      expiry_date: 1_900_000_000_000,
    });
    try {
      expect(readMiniMaxCliCredentialsCached({ homeDir: home, ttlMs: 0 })).toEqual({
        type: "oauth",
        provider: "minimax-portal",
        access: "minimax-access",
        refresh: "minimax-refresh",
        expires: 1_900_000_000_000,
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("lifts Google identity from the Gemini id token", () => {
    const payload = Buffer.from(
      JSON.stringify({ sub: "google-account-42", email: "user@example.com" }),
    ).toString("base64url");
    const home = writeCredential(".gemini/oauth_creds.json", {
      access_token: "gemini-access",
      refresh_token: "gemini-refresh",
      id_token: `header.${payload}.signature`,
      expiry_date: 1_900_000_000_000,
    });
    try {
      expect(readGeminiCliCredentialsCached({ homeDir: home, ttlMs: 0 })).toEqual({
        type: "oauth",
        provider: "google-gemini-cli",
        access: "gemini-access",
        refresh: "gemini-refresh",
        expires: 1_900_000_000_000,
        accountId: "google-account-42",
        email: "user@example.com",
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
