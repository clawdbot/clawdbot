#!/usr/bin/env -S node --import tsx
import fs from "node:fs/promises";
import path from "node:path";

type CodexAuthJson = {
  tokens?: {
    account_id?: unknown;
    id_token?: unknown;
  };
};

type JwtParts = {
  header: string;
  payload: Record<string, unknown>;
  signature: string;
};

function decodeBase64UrlJson(value: string): Record<string, unknown> {
  const decoded = Buffer.from(value, "base64url").toString("utf-8");
  const parsed: unknown = JSON.parse(decoded);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JWT payload is not a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function encodeBase64UrlJson(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), "utf-8").toString("base64url");
}

function parseJwt(value: string): JwtParts {
  const parts = value.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1]) {
    throw new Error("id_token is not a JWT.");
  }
  return {
    header: parts[0],
    payload: decodeBase64UrlJson(parts[1]),
    signature: parts[2] ?? "",
  };
}

function stringifyJwt(parts: JwtParts): string {
  return [parts.header, encodeBase64UrlJson(parts.payload), parts.signature].join(".");
}

export function patchCodexAuthForCi(auth: CodexAuthJson): {
  auth: CodexAuthJson;
  changed: boolean;
} {
  const tokens = auth.tokens;
  if (!tokens) {
    return { auth, changed: false };
  }
  const accountId = typeof tokens.account_id === "string" ? tokens.account_id.trim() : "";
  const idToken = typeof tokens.id_token === "string" ? tokens.id_token.trim() : "";
  if (!accountId || !idToken) {
    return { auth, changed: false };
  }

  const jwt = parseJwt(idToken);
  if (typeof jwt.payload.chatgpt_account_id === "string" && jwt.payload.chatgpt_account_id) {
    return { auth, changed: false };
  }

  return {
    auth: {
      ...auth,
      tokens: {
        ...tokens,
        // Newer Codex app-server builds read ChatGPT account metadata from
        // id_token claims. Older local auth files can have the same value only
        // at tokens.account_id, so patch the staged Docker copy for CI.
        id_token: stringifyJwt({
          ...jwt,
          payload: {
            ...jwt.payload,
            chatgpt_account_id: accountId,
          },
        }),
      },
    },
    changed: true,
  };
}

export async function prepareCodexCiAuth(authPath: string): Promise<boolean> {
  const raw = await fs.readFile(authPath, "utf-8");
  const parsed = JSON.parse(raw) as CodexAuthJson;
  const { auth, changed } = patchCodexAuthForCi(parsed);
  if (!changed) {
    return false;
  }
  const stat = await fs.stat(authPath);
  await fs.writeFile(authPath, `${JSON.stringify(auth, null, 2)}\n`, "utf-8");
  await fs.chmod(authPath, stat.mode);
  return true;
}

if (path.basename(process.argv[1] ?? "") === "prepare-codex-ci-auth.ts") {
  const authPath = process.argv[2];
  if (!authPath) {
    throw new Error("Usage: node --import tsx scripts/prepare-codex-ci-auth.ts <auth-json-path>");
  }
  const changed = await prepareCodexCiAuth(authPath);
  if (changed) {
    console.error("Prepared staged Codex auth metadata for CI.");
  }
}
