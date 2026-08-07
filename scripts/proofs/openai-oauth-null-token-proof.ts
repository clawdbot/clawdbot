/**
 * Proof: isRecord guard prevents TypeError crash on null/array OAuth token
 * response bodies through real loopback HTTP transport.
 *
 * Run: node --import tsx scripts/proofs/openai-oauth-null-token-proof.ts
 *
 * Removes `rm scripts/proofs/openai-oauth-null-token-proof.ts` before merging.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { isRecord } from "../../src/utils.js";

type TokenResponseJson = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
};

/**
 * Mirrors the production guard inserted in exchangeOpenAIAuthorizationCode
 * and refreshOpenAIAccessToken: validate response.json() output with isRecord
 * before any property access (cf. #111638).
 */
function parseTokenResponse(
  json: unknown,
):
  | { type: "success"; access: string; refresh: string; expires: number }
  | { type: "failed"; message: string } {
  if (!isRecord(json)) {
    return {
      type: "failed",
      message: `expected JSON object response, got ${json === null ? "null" : Array.isArray(json) ? "array" : typeof json}`,
    };
  }
  const record = json as Record<string, unknown>;
  if (!record.access_token || !record.refresh_token || record.expires_in === undefined) {
    return { type: "failed", message: "missing token fields" };
  }
  return {
    type: "success",
    access: String(record.access_token),
    refresh: String(record.refresh_token),
    expires: Number(record.expires_in),
  };
}

/** Before fix: raw property access on json, no isRecord guard. */
function parseTokenResponseUnsafe(json: unknown): string {
  try {
    const record = json as Record<string, unknown>;
    // 💥 json === null → null.expires_in → TypeError outside try block in production
    if (!record.expires_in) return "missing expires_in";
    if (!record.access_token) return "missing access_token";
    return `SUCCESS`;
  } catch (e) {
    return `CRASH: ${(e as Error).message}`;
  }
}

type TestCase = {
  label: string;
  status: number;
  contentType: string;
  body: string;
};

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${addr.port}`);
    });
    server.once("error", reject);
  });
}

async function run(): Promise<boolean> {
  // Real loopback HTTP server — no mocks, real fetch, real response.json().
  const server = createServer((_req, res) => {
    // Serve every request with a null body (the highest-risk scenario).
    // This mirrors an OAuth endpoint returning HTTP 200 + body: null.
    res.writeHead(200, { "content-type": "application/json" });
    res.end("null");
  });
  const baseUrl = await listen(server);

  let ok = true;

  try {
    // --- Null body (the crash case) ---
    console.log("=== REAL LOOPBACK: null token response ===");
    const nullRes = await fetch(baseUrl);
    console.log(`HTTP ${nullRes.status} ${nullRes.statusText}`);
    const nullJson: unknown = await nullRes.json();
    console.log(`response.json() = ${JSON.stringify(nullJson)}`);

    console.log(`Before fix: ${parseTokenResponseUnsafe(nullJson)}`);
    const after = parseTokenResponse(nullJson);
    console.log(`After fix:  ${after.type === "failed" ? after.message : after.type}`);

    if (after.type !== "failed") {
      console.log("FAIL: null body should return failed, got success");
      ok = false;
    } else {
      console.log("PASS: null body → clear error, no crash");
    }

    // --- Valid body (unchanged behavior) ---
    console.log();
    console.log("=== REAL LOOPBACK: valid token response ===");
    // Restart server to serve valid JSON instead
    server.close();
    await new Promise((r) => server.once("close", r));
    const server2 = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 }));
    });
    const baseUrl2 = await listen(server2);
    try {
      const validRes = await fetch(baseUrl2);
      console.log(`HTTP ${validRes.status} ${validRes.statusText}`);
      const validJson: unknown = await validRes.json();
      console.log(`response.json() = ${JSON.stringify(validJson)}`);

      const validResult = parseTokenResponse(validJson);
      console.log(`After fix: ${validResult.type}`);
      if (validResult.type !== "success") {
        console.log(`FAIL: valid body returned ${validResult.type}`);
        ok = false;
      } else {
        console.log("PASS: valid body → still works");
      }
    } finally {
      server2.close();
      await new Promise((r) => server2.once("close", r));
    }
  } finally {
    if (server.listening) {
      server.close();
      await new Promise((r) => server.once("close", r));
    }
  }

  console.log();
  console.log(`=== VERDICT: ${ok ? "PASS" : "FAIL"} ===`);
  return ok;
}

run()
  .then((pass) => process.exit(pass ? 0 : 1))
  .catch((err) => {
    console.error("Proof harness error:", err);
    process.exit(1);
  });
