import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveOpenClawAgentDir } from "../agents/agent-paths.js";
import { AUTH_PROFILE_FILENAME } from "../agents/auth-profiles/constants.js";
import { __testing as controlPlaneRateLimitTesting } from "./control-plane-rate-limit.js";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const CONFIG_SECRETREF_RPC_TIMEOUT_MS = 20_000;

let startedServer: Awaited<ReturnType<typeof startServerWithClient>> | null = null;
let sharedTempRoot: string;

function requireWs(): Awaited<ReturnType<typeof startServerWithClient>>["ws"] {
  if (!startedServer) {
    throw new Error("gateway test server not started");
  }
  return startedServer.ws;
}

beforeAll(async () => {
  sharedTempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sessions-config-"));
  startedServer = await startServerWithClient(undefined, { controlUiEnabled: true });
  await connectOk(requireWs());
});

afterAll(async () => {
  if (!startedServer) {
    return;
  }
  startedServer.ws.close();
  await startedServer.server.close();
  startedServer = null;
  await fs.rm(sharedTempRoot, { recursive: true, force: true });
});

async function resetTempDir(name: string): Promise<string> {
  const dir = path.join(sharedTempRoot, name);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function getConfigHash() {
  const current = await rpcReq<{
    hash?: string;
  }>(requireWs(), "config.get", {});
  expect(current.ok).toBe(true);
  expect(typeof current.payload?.hash).toBe("string");
  return String(current.payload?.hash);
}

async function sendConfigApply(params: { raw: unknown; baseHash?: string }, timeoutMs?: number) {
  return await rpcReq(requireWs(), "config.apply", params, timeoutMs);
}

async function expectSchemaLookupInvalid(path: unknown) {
  const res = await rpcReq<{ ok?: boolean }>(requireWs(), "config.schema.lookup", { path });
  expect(res.ok).toBe(false);
  expect(res.error?.message ?? "").toContain("invalid config.schema.lookup params");
}

async function writeUnresolvedAuthProfileTokenRef(missingEnvVar: string) {
  delete process.env[missingEnvVar];
  const authStorePath = path.join(resolveOpenClawAgentDir(), AUTH_PROFILE_FILENAME);
  await fs.mkdir(path.dirname(authStorePath), { recursive: true });
  await fs.writeFile(
    authStorePath,
    `${JSON.stringify(
      {
        version: 1,
        profiles: {
          "custom:token": {
            type: "token",
            provider: "custom",
            tokenRef: { source: "env", provider: "default", id: missingEnvVar },
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
}

beforeEach(() => {
  controlPlaneRateLimitTesting.resetControlPlaneRateLimitState();
});

describe("gateway config methods", () => {
  it("rejects config.set when SecretRef resolution fails", async () => {
    const missingEnvVar = `OPENCLAW_MISSING_SECRETREF_${Date.now()}`;
    delete process.env[missingEnvVar];
    const current = await rpcReq<{
      hash?: string;
      config?: Record<string, unknown>;
    }>(requireWs(), "config.get", {});
    expect(current.ok).toBe(true);
    expect(typeof current.payload?.hash).toBe("string");
    expect(current.payload?.config).toBeTruthy();

    const nextConfig = structuredClone(current.payload?.config ?? {});
    const gateway = (nextConfig.gateway ??= {}) as Record<string, unknown>;
    gateway.auth = {
      mode: "token",
      token: { source: "env", provider: "default", id: missingEnvVar },
    };

    const res = await rpcReq<{ ok?: boolean; error?: { message?: string } }>(
      requireWs(),
      "config.set",
      {
        raw: JSON.stringify(nextConfig, null, 2),
        baseHash: current.payload?.hash,
      },
      CONFIG_SECRETREF_RPC_TIMEOUT_MS,
    );
    expect(res.ok).toBe(false);
    expect(res.error?.message ?? "").toContain("active SecretRef resolution failed");
    const afterHash = await getConfigHash();
    expect(afterHash).toBe(current.payload?.hash);
  });

  it("round-trips config.set and returns the live config path", async () => {
    const { createConfigIO } = await import("../config/config.js");
    const current = await rpcReq<{
      raw?: unknown;
      hash?: string;
      config?: Record<string, unknown>;
    }>(requireWs(), "config.get", {});
    expect(current.ok).toBe(true);
    expect(typeof current.payload?.hash).toBe("string");
    expect(current.payload?.config).toBeTruthy();

    const res = await rpcReq<{
      ok?: boolean;
      path?: string;
      config?: Record<string, unknown>;
    }>(requireWs(), "config.set", {
      raw: JSON.stringify(current.payload?.config ?? {}, null, 2),
      baseHash: current.payload?.hash,
    });

    expect(res.ok).toBe(true);
    expect(res.payload?.path).toBe(createConfigIO().configPath);
    expect(res.payload?.config).toBeTruthy();
  });

  it("does not reject config.set for unresolved auth-profile refs outside submitted config", async () => {
    const missingEnvVar = `OPENCLAW_MISSING_AUTH_PROFILE_REF_${Date.now()}`;
    await writeUnresolvedAuthProfileTokenRef(missingEnvVar);

    const current = await rpcReq<{
      hash?: string;
      config?: Record<string, unknown>;
    }>(requireWs(), "config.get", {});
    expect(current.ok).toBe(true);
    expect(typeof current.payload?.hash).toBe("string");
    expect(current.payload?.config).toBeTruthy();

    const res = await rpcReq<{ ok?: boolean; error?: { message?: string } }>(
      requireWs(),
      "config.set",
      {
        raw: JSON.stringify(current.payload?.config ?? {}, null, 2),
        baseHash: current.payload?.hash,
      },
    );

    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
  });

  it("returns config.set validation details in the top-level error message", async () => {
    const res = await rpcReq<{
      ok?: boolean;
      error?: {
        message?: string;
      };
    }>(requireWs(), "config.set", {
      raw: JSON.stringify({ gateway: { bind: 123 } }),
      baseHash: await getConfigHash(),
    });
    const error = res.error as
      | {
          message?: string;
          details?: {
            issues?: Array<{ path?: string; message?: string }>;
          };
        }
      | undefined;

    expect(res.ok).toBe(false);
    expect(error?.message ?? "").toContain("invalid config:");
    expect(error?.message ?? "").toContain("gateway.bind");
    expect(error?.message ?? "").toContain("allowed:");
    expect(error?.details?.issues?.[0]?.path).toBe("gateway.bind");
  });

  it("returns a path-scoped config schema lookup", async () => {
    const res = await rpcReq<{
      path: string;
      hintPath?: string;
      children?: Array<{ key: string; path: string; required: boolean; hintPath?: string }>;
      schema?: { properties?: unknown };
    }>(requireWs(), "config.schema.lookup", {
      path: "gateway.auth",
    });

    expect(res.ok).toBe(true);
    expect(res.payload?.path).toBe("gateway.auth");
    expect(res.payload?.hintPath).toBe("gateway.auth");
    const tokenChild = res.payload?.children?.find((child) => child.key === "token");
    expect(tokenChild).toMatchObject({
      key: "token",
      path: "gateway.auth.token",
      hintPath: "gateway.auth.token",
    });
    expect(res.payload?.schema?.properties).toBeUndefined();
  });

  it("rejects config.schema.lookup when the path is missing", async () => {
    const res = await rpcReq<{ ok?: boolean }>(requireWs(), "config.schema.lookup", {
      path: "gateway.notReal.path",
    });

    expect(res.ok).toBe(false);
    expect(res.error?.message).toBe("config schema path not found");
  });

  it.each([
    { name: "rejects config.schema.lookup when the path is only whitespace", path: "   " },
    {
      name: "rejects config.schema.lookup when the path exceeds the protocol limit",
      path: `gateway.${"a".repeat(1020)}`,
    },
    {
      name: "rejects config.schema.lookup when the path contains invalid characters",
      path: "gateway.auth\nspoof",
    },
    {
      name: "rejects config.schema.lookup when the path is not a string",
      path: 42,
    },
  ])("$name", async ({ path }) => {
    await expectSchemaLookupInvalid(path);
  });

  it("rejects prototype-chain config.schema.lookup paths without reflecting them", async () => {
    const res = await rpcReq<{ ok?: boolean }>(requireWs(), "config.schema.lookup", {
      path: "constructor",
    });

    expect(res.ok).toBe(false);
    expect(res.error?.message).toBe("config schema path not found");
  });

  it("returns noop for config.patch when config is unchanged", async () => {
    const current = await rpcReq<{
      config?: Record<string, unknown>;
      hash?: string;
    }>(requireWs(), "config.get", {});
    expect(current.ok).toBe(true);

    // Patch with the same config — no actual changes
    const res = await rpcReq<{
      ok?: boolean;
      noop?: boolean;
      config?: Record<string, unknown>;
    }>(requireWs(), "config.patch", {
      raw: JSON.stringify(current.payload?.config ?? {}),
      baseHash: current.payload?.hash,
    });

    expect(res.ok).toBe(true);
    expect(res.payload?.noop).toBe(true);
    // Config hash should not change (no file write)
    const after = await rpcReq<{ hash?: string }>(requireWs(), "config.get", {});
    expect(after.payload?.hash).toBe(current.payload?.hash);
  });

  it("rejects config.patch when raw is null", async () => {
    const res = await rpcReq<{ ok?: boolean }>(requireWs(), "config.patch", {
      raw: "null",
      baseHash: await getConfigHash(),
    });
    expect(res.ok).toBe(false);
    expect(res.error?.message ?? "").toContain("raw must be an object");
  });

  it("rejects config.patch when merged SecretRefs cannot resolve", async () => {
    const missingEnvVar = `OPENCLAW_MISSING_SECRETREF_PATCH_${Date.now()}`;
    delete process.env[missingEnvVar];
    const beforeHash = await getConfigHash();
    const res = await rpcReq<{ ok?: boolean; error?: { message?: string } }>(
      requireWs(),
      "config.patch",
      {
        raw: JSON.stringify({
          gateway: {
            auth: {
              mode: "token",
              token: {
                source: "env",
                provider: "default",
                id: missingEnvVar,
              },
            },
          },
        }),
        baseHash: beforeHash,
      },
      CONFIG_SECRETREF_RPC_TIMEOUT_MS,
    );
    expect(res.ok).toBe(false);
    expect(res.error?.message ?? "").toContain("active SecretRef resolution failed");
    const afterHash = await getConfigHash();
    expect(afterHash).toBe(beforeHash);
  });
});

describe("gateway config.apply", () => {
  it("rejects config.apply when SecretRef resolution fails", async () => {
    const missingEnvVar = `OPENCLAW_MISSING_SECRETREF_APPLY_${Date.now()}`;
    delete process.env[missingEnvVar];
    const current = await rpcReq<{
      hash?: string;
      raw?: string | null;
      config?: Record<string, unknown>;
    }>(requireWs(), "config.get", {});
    expect(current.ok).toBe(true);
    expect(typeof current.payload?.hash).toBe("string");
    const nextConfig = structuredClone(current.payload?.config ?? {});
    const gateway = (nextConfig.gateway ??= {}) as Record<string, unknown>;
    gateway.auth = {
      mode: "token",
      token: { source: "env", provider: "default", id: missingEnvVar },
    };

    const res = await sendConfigApply(
      {
        raw: JSON.stringify(nextConfig, null, 2),
        baseHash: current.payload?.hash,
      },
      CONFIG_SECRETREF_RPC_TIMEOUT_MS,
    );
    expect(res.ok).toBe(false);
    expect(res.error?.message ?? "").toContain("active SecretRef resolution failed");

    const after = await rpcReq<{
      hash?: string;
      raw?: string | null;
    }>(requireWs(), "config.get", {});
    expect(after.ok).toBe(true);
    expect(after.payload?.hash).toBe(current.payload?.hash);
    expect(after.payload?.raw).toBe(current.payload?.raw);
  });

  it("does not reject config.apply for unresolved auth-profile refs outside submitted config", async () => {
    const missingEnvVar = `OPENCLAW_MISSING_AUTH_PROFILE_REF_APPLY_${Date.now()}`;
    await writeUnresolvedAuthProfileTokenRef(missingEnvVar);

    const current = await rpcReq<{
      config?: Record<string, unknown>;
      hash?: string;
    }>(requireWs(), "config.get", {});
    expect(current.ok).toBe(true);
    expect(current.payload?.config).toBeTruthy();

    const res = await sendConfigApply({
      raw: JSON.stringify(current.payload?.config ?? {}, null, 2),
      baseHash: current.payload?.hash,
    });
    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
  });

  it("rejects invalid raw config", async () => {
    const currentHash = await getConfigHash();
    const res = await sendConfigApply({ raw: "{", baseHash: currentHash });
    expect(res.ok).toBe(false);
    expect(res.error?.message ?? "").toMatch(/invalid|SyntaxError/i);
  });

  it("requires raw to be a string", async () => {
    const currentHash = await getConfigHash();
    const res = await sendConfigApply({
      raw: { gateway: { mode: "local" } },
      baseHash: currentHash,
    });
    expect(res.ok).toBe(false);
    expect(res.error?.message ?? "").toContain("raw");
  });
});

describe("gateway server sessions", () => {
  it("filters sessions by agentId", async () => {
    const dir = await resetTempDir("agents");
    testState.sessionConfig = {
      store: path.join(dir, "{agentId}", "sessions.json"),
    };
    testState.agentsConfig = {
      list: [{ id: "home", default: true }, { id: "work" }],
    };
    const homeDir = path.join(dir, "home");
    const workDir = path.join(dir, "work");
    await fs.mkdir(homeDir, { recursive: true });
    await fs.mkdir(workDir, { recursive: true });
    await writeSessionStore({
      storePath: path.join(homeDir, "sessions.json"),
      agentId: "home",
      entries: {
        main: {
          sessionId: "sess-home-main",
          updatedAt: Date.now(),
        },
        "discord:group:dev": {
          sessionId: "sess-home-group",
          updatedAt: Date.now() - 1000,
        },
      },
    });
    await writeSessionStore({
      storePath: path.join(workDir, "sessions.json"),
      agentId: "work",
      entries: {
        main: {
          sessionId: "sess-work-main",
          updatedAt: Date.now(),
        },
      },
    });

    const homeSessions = await rpcReq<{
      sessions: Array<{ key: string }>;
    }>(requireWs(), "sessions.list", {
      includeGlobal: false,
      includeUnknown: false,
      agentId: "home",
    });
    expect(homeSessions.ok).toBe(true);
    expect(homeSessions.payload?.sessions.map((s) => s.key).toSorted()).toEqual([
      "agent:home:discord:group:dev",
      "agent:home:main",
    ]);

    const workSessions = await rpcReq<{
      sessions: Array<{ key: string }>;
    }>(requireWs(), "sessions.list", {
      includeGlobal: false,
      includeUnknown: false,
      agentId: "work",
    });
    expect(workSessions.ok).toBe(true);
    expect(workSessions.payload?.sessions.map((s) => s.key)).toEqual(["agent:work:main"]);
  });

  it("resolves and patches main alias to default agent main key", async () => {
    const dir = await resetTempDir("main-alias");
    const storePath = path.join(dir, "sessions.json");
    testState.sessionStorePath = storePath;
    testState.agentsConfig = { list: [{ id: "ops", default: true }] };
    testState.sessionConfig = { mainKey: "work" };

    await writeSessionStore({
      storePath,
      agentId: "ops",
      mainKey: "work",
      entries: {
        main: {
          sessionId: "sess-ops-main",
          updatedAt: Date.now(),
        },
      },
    });

    const resolved = await rpcReq<{ ok: true; key: string }>(requireWs(), "sessions.resolve", {
      key: "main",
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.payload?.key).toBe("agent:ops:work");

    const patched = await rpcReq<{ ok: true; key: string }>(requireWs(), "sessions.patch", {
      key: "main",
      thinkingLevel: "medium",
    });
    expect(patched.ok).toBe(true);
    expect(patched.payload?.key).toBe("agent:ops:work");

    const stored = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
      string,
      { thinkingLevel?: string }
    >;
    expect(stored["agent:ops:work"]?.thinkingLevel).toBe("medium");
    expect(stored.main).toBeUndefined();
  });
});
