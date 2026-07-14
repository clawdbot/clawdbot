// Config patch tests cover control-UI config edits, secret-ref writes, auth
// profile persistence, rate limiting, and session store side effects.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveDefaultAgentDir } from "../agents/agent-scope.js";
import { AUTH_PROFILE_FILENAME } from "../agents/auth-profiles/path-constants.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { deleteTestEnvValue } from "../test-utils/env.js";
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
let rateLimitEpochMs = Date.now();

function requireWs(): Awaited<ReturnType<typeof startServerWithClient>>["ws"] {
  if (!startedServer) {
    throw new Error("gateway test server not started");
  }
  return startedServer.ws;
}

function requireConfigObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

beforeAll(async () => {
  sharedTempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sessions-config-"));
  startedServer = await startServerWithClient(undefined, { controlUiEnabled: true });
  await connectOk(requireWs());
});

afterAll(async () => {
  vi.restoreAllMocks();
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

async function writeJsonFile(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
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

async function sendConfigSet(params: { raw: string; baseHash?: string }, timeoutMs?: number) {
  return await rpcReq(requireWs(), "config.set", params, timeoutMs);
}

function configRawPayload(config: unknown, baseHash?: string) {
  return {
    raw: JSON.stringify(config, null, 2),
    baseHash,
  };
}

function configWithGatewayTokenSecretRef(config: Record<string, unknown>, envVar: string) {
  const nextConfig = structuredClone(config);
  const gateway = (nextConfig.gateway ??= {}) as Record<string, unknown>;
  gateway.auth = {
    mode: "token",
    token: { source: "env", provider: "default", id: envVar },
  };
  return nextConfig;
}

async function getCurrentConfigObject() {
  const current = await rpcReq<{
    raw?: string | null;
    hash?: string;
    path?: string;
    config?: Record<string, unknown>;
  }>(requireWs(), "config.get", {});
  expect(current.ok).toBe(true);
  expect(typeof current.payload?.hash).toBe("string");
  expect(typeof current.payload?.path).toBe("string");
  return {
    hash: String(current.payload?.hash),
    path: String(current.payload?.path),
    raw: current.payload?.raw,
    config: requireConfigObject(current.payload?.config, "current config"),
  };
}

async function restoreConfigFileForTest(
  original: Awaited<ReturnType<typeof getCurrentConfigObject>>,
) {
  await writeJsonFile(original.path, original.config);
}

function makeRouteBinding(index: number) {
  return {
    agentId: "main",
    match: {
      channel: "telegram",
      peer: {
        kind: "direct",
        id: `user-${index}`,
      },
    },
  };
}

function makeAgentEntry(id: string, extra: Record<string, unknown> = {}) {
  return { id, ...extra };
}

async function expectSchemaLookupInvalid(pathValue: unknown) {
  const res = await rpcReq<{ ok?: boolean }>(requireWs(), "config.schema.lookup", { pathValue });
  expect(res.ok).toBe(false);
  expect(res.error?.message ?? "").toContain("invalid config.schema.lookup params");
}

async function writeUnresolvedAuthProfileTokenRef(missingEnvVar: string) {
  deleteTestEnvValue(missingEnvVar);
  const authStorePath = path.join(resolveDefaultAgentDir({}), AUTH_PROFILE_FILENAME);
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
  rateLimitEpochMs += 60_000;
  vi.spyOn(Date, "now").mockReturnValue(rateLimitEpochMs);
});

describe("gateway config methods", () => {
  it("rejects config.set when SecretRef resolution fails", async () => {
    const missingEnvVar = `OPENCLAW_MISSING_SECRETREF_${Date.now()}`;
    deleteTestEnvValue(missingEnvVar);
    const current = await getCurrentConfigObject();
    const nextConfig = configWithGatewayTokenSecretRef(current.config, missingEnvVar);

    const res = await sendConfigSet(
      configRawPayload(nextConfig, current.hash),
      CONFIG_SECRETREF_RPC_TIMEOUT_MS,
    );
    expect(res.ok).toBe(false);
    expect(res.error?.message ?? "").toContain("active SecretRef resolution failed");
    const afterHash = await getConfigHash();
    expect(afterHash).toBe(current.hash);
  });

  it("round-trips config.set and returns the live config path", async () => {
    const { createConfigIO } = await import("../config/config.js");
    const current = await getCurrentConfigObject();

    const res = await rpcReq<{
      ok?: boolean;
      path?: string;
      config?: Record<string, unknown>;
    }>(requireWs(), "config.set", {
      ...configRawPayload(current.config, current.hash),
    });

    expect(res.ok).toBe(true);
    expect(res.payload?.path).toBe(createConfigIO().configPath);
    requireConfigObject(res.payload?.config, "updated config");
  });

  it("returns the persisted config from config.set responses", async () => {
    const current = await getCurrentConfigObject();
    const nextConfig = structuredClone(current.config);
    delete nextConfig.meta;

    const gateway = (nextConfig.gateway ??= {}) as Record<string, unknown>;
    gateway.port = 19001;

    const res = await rpcReq<{
      ok?: boolean;
      config?: Record<string, unknown>;
    }>(requireWs(), "config.set", {
      ...configRawPayload(nextConfig, current.hash),
    });
    expect(res.error).toBeUndefined();
    expect(res.ok).toBe(true);

    const after = await rpcReq<{
      config?: Record<string, unknown>;
    }>(requireWs(), "config.get", {});
    expect(after.ok).toBe(true);
    expect(res.payload?.config).toEqual(after.payload?.config);
    requireConfigObject(res.payload?.config, "response config");
  });

  it("accepts runtime-shaped config.set when bundled provider baseUrl was only defaulted", async () => {
    const { createConfigIO, resetConfigRuntimeState } = await import("../config/config.js");
    const configPath = createConfigIO().configPath;
    try {
      await writeJsonFile(configPath, {
        models: {
          providers: {
            openai: {
              agentRuntime: { id: "openclaw" },
            },
          },
        },
      });
      resetConfigRuntimeState();

      const current = await getCurrentConfigObject();
      const nextConfig = structuredClone(current.config);
      const providers = ((nextConfig.models as Record<string, unknown>).providers ?? {}) as Record<
        string,
        Record<string, unknown>
      >;
      providers.openai ??= {};
      providers.openai.baseUrl = "";
      providers.openai.models = [];

      const gateway = (nextConfig.gateway ??= {}) as Record<string, unknown>;
      gateway.port = 19002;

      const res = await rpcReq<{
        ok?: boolean;
        error?: { message?: string };
      }>(requireWs(), "config.set", {
        ...configRawPayload(nextConfig, current.hash),
      });

      expect(res.error).toBeUndefined();
      expect(res.ok).toBe(true);
      const persisted = await fs.readFile(configPath, "utf-8");
      expect(persisted).toContain('"port": 19002');
      expect(persisted).not.toContain('"baseUrl"');
    } finally {
      await fs.rm(configPath, { force: true });
      resetConfigRuntimeState();
    }
  });

  it("accepts config.patch when bundled provider baseUrl was only defaulted", async () => {
    const { createConfigIO, resetConfigRuntimeState } = await import("../config/config.js");
    const configPath = createConfigIO().configPath;
    try {
      await writeJsonFile(configPath, {
        models: {
          providers: {
            openai: {
              agentRuntime: { id: "openclaw" },
            },
          },
        },
      });
      resetConfigRuntimeState();

      const current = await getCurrentConfigObject();

      const res = await rpcReq<{
        ok?: boolean;
        error?: { message?: string };
      }>(requireWs(), "config.patch", {
        raw: JSON.stringify({ gateway: { port: 19003 } }),
        baseHash: current.hash,
      });

      expect(res.error).toBeUndefined();
      expect(res.ok).toBe(true);
      const persisted = await fs.readFile(configPath, "utf-8");
      expect(persisted).toContain('"port": 19003');
      expect(persisted).not.toContain('"baseUrl"');
      expect(persisted).not.toContain('"models": []');
    } finally {
      await fs.rm(configPath, { force: true });
      resetConfigRuntimeState();
    }
  });

  it("preserves authored empty bundled provider models during config.patch", async () => {
    const { createConfigIO, resetConfigRuntimeState } = await import("../config/config.js");
    const configPath = createConfigIO().configPath;
    try {
      await writeJsonFile(configPath, {
        models: {
          providers: {
            openai: {
              agentRuntime: { id: "openclaw" },
              models: [],
            },
          },
        },
      });
      resetConfigRuntimeState();

      const current = await getCurrentConfigObject();

      const res = await rpcReq<{
        ok?: boolean;
        error?: { message?: string };
      }>(requireWs(), "config.patch", {
        raw: JSON.stringify({ gateway: { port: 19004 } }),
        baseHash: current.hash,
      });

      expect(res.error).toBeUndefined();
      expect(res.ok).toBe(true);
      const persisted = JSON.parse(await fs.readFile(configPath, "utf-8")) as {
        models?: { providers?: { openai?: { baseUrl?: unknown; models?: unknown } } };
      };
      expect(persisted.models?.providers?.openai?.baseUrl).toBeUndefined();
      expect(persisted.models?.providers?.openai?.models).toEqual([]);
    } finally {
      await fs.rm(configPath, { force: true });
      resetConfigRuntimeState();
    }
  });

  it("redacts browser cdpUrl credentials from config.get responses", async () => {
    const { createConfigIO, resetConfigRuntimeState } = await import("../config/config.js");
    const configPath = createConfigIO().configPath;
    try {
      await writeJsonFile(configPath, {
        browser: {
          cdpUrl: "https://user:pass@chrome.browserless.io?token=supersecret123",
          profiles: {
            remote: {
              cdpUrl: "https://alice:secret@chrome.remote.example.com?token=profile-secret",
            },
            local: {
              cdpUrl: "ws://127.0.0.1:9222",
            },
          },
        },
      });
      resetConfigRuntimeState();

      const after = await rpcReq<{
        raw?: string | null;
        config?: {
          browser?: {
            cdpUrl?: string;
            profiles?: Record<string, { cdpUrl?: string }>;
          };
        };
      }>(requireWs(), "config.get", {});
      expect(after.ok).toBe(true);
      expect(after.payload?.config?.browser?.cdpUrl).toBe("__OPENCLAW_REDACTED__");
      expect(after.payload?.config?.browser?.profiles?.remote?.cdpUrl).toBe(
        "__OPENCLAW_REDACTED__",
      );
      expect(after.payload?.config?.browser?.profiles?.local?.cdpUrl).toBe("ws://127.0.0.1:9222");
      if (typeof after.payload?.raw === "string") {
        expect(after.payload.raw).toContain("__OPENCLAW_REDACTED__");
        expect(after.payload.raw).not.toContain("supersecret123");
        expect(after.payload.raw).not.toContain("user:pass@");
        expect(after.payload.raw).not.toContain("profile-secret");
        expect(after.payload.raw).not.toContain("alice:secret@");
      }
    } finally {
      await fs.rm(configPath, { force: true });
      resetConfigRuntimeState();
    }
  });

  it("round-trips prototype-like browser profile names through config.patch", async () => {
    const original = await getCurrentConfigObject();
    const profileNames = ["constructor", "prototype"] as const;

    try {
      const create = await rpcReq<{ ok?: boolean }>(requireWs(), "config.patch", {
        raw: JSON.stringify({
          browser: {
            profiles: Object.fromEntries(
              profileNames.map((name, index) => [
                name,
                {
                  cdpPort: 18991 + index,
                  color: "#0066CC",
                  constructor: { polluted: true },
                  prototype: { polluted: true },
                },
              ]),
            ),
          },
        }),
        baseHash: original.hash,
      });
      expect(create.ok).toBe(true);

      const afterCreate = await getCurrentConfigObject();
      const browser = requireConfigObject(afterCreate.config.browser, "browser");
      const profiles = requireConfigObject(browser.profiles, "browser.profiles");
      for (const [index, name] of profileNames.entries()) {
        const profile = requireConfigObject(profiles[name], `browser.profiles.${name}`);
        expect(profile.cdpPort).toBe(18991 + index);
        expect(Object.hasOwn(profile, "constructor")).toBe(false);
        expect(Object.hasOwn(profile, "prototype")).toBe(false);
      }
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();

      const remove = await rpcReq<{ ok?: boolean }>(requireWs(), "config.patch", {
        raw: JSON.stringify({
          browser: { profiles: { constructor: null, prototype: null } },
        }),
        baseHash: afterCreate.hash,
      });
      expect(remove.ok).toBe(true);

      const afterRemove = await getCurrentConfigObject();
      const afterBrowser = requireConfigObject(afterRemove.config.browser, "browser");
      const afterProfiles = requireConfigObject(afterBrowser.profiles, "browser.profiles");
      for (const name of profileNames) {
        expect(Object.hasOwn(afterProfiles, name)).toBe(false);
      }
    } finally {
      await restoreConfigFileForTest(original);
    }
  });

  it("does not reject config.set for unresolved auth-profile refs outside submitted config", async () => {
    const missingEnvVar = `OPENCLAW_MISSING_AUTH_PROFILE_REF_${Date.now()}`;
    await writeUnresolvedAuthProfileTokenRef(missingEnvVar);

    const current = await getCurrentConfigObject();

    const res = await rpcReq<{ ok?: boolean; error?: { message?: string } }>(
      requireWs(),
      "config.set",
      configRawPayload(current.config, current.hash),
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
    expect(tokenChild?.key).toBe("token");
    expect(tokenChild?.path).toBe("gateway.auth.token");
    expect(tokenChild?.hintPath).toBe("gateway.auth.token");
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
    { name: "rejects config.schema.lookup when the path is only whitespace", pathLocal: "   " },
    {
      name: "rejects config.schema.lookup when the path exceeds the protocol limit",
      pathLocal: `gateway.${"a".repeat(1020)}`,
    },
    {
      name: "rejects config.schema.lookup when the path contains invalid characters",
      pathLocal: "gateway.auth\nspoof",
    },
    {
      name: "rejects config.schema.lookup when the path is not a string",
      pathLocal: 42,
    },
  ])("$name", async ({ pathLocal }) => {
    await expectSchemaLookupInvalid(pathLocal);
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

  it("rejects config.patch that shrinks an existing array without replacePaths", async () => {
    const original = await getCurrentConfigObject();
    const bindings = [0, 1, 2].map(makeRouteBinding);
    const seededConfig = { ...original.config, bindings };
    const seed = await sendConfigApply(configRawPayload(seededConfig, original.hash));
    expect(seed.ok).toBe(true);

    try {
      const before = await getCurrentConfigObject();
      const res = await rpcReq<{ ok?: boolean }>(requireWs(), "config.patch", {
        raw: JSON.stringify({ bindings: [bindings[0]] }),
        baseHash: before.hash,
      });

      expect(res.ok).toBe(false);
      expect(res.error?.message ?? "").toContain(
        "config.patch would remove entries from array path(s): bindings",
      );
      const after = await getCurrentConfigObject();
      expect(after.hash).toBe(before.hash);
      expect(after.config.bindings).toEqual(bindings);
    } finally {
      await restoreConfigFileForTest(original);
    }
  });

  it("rejects config.patch that removes existing array entries without shrinking length", async () => {
    const original = await getCurrentConfigObject();
    const bindings = [0, 1].map(makeRouteBinding);
    const seededConfig = { ...original.config, bindings };
    const seed = await sendConfigApply(configRawPayload(seededConfig, original.hash));
    expect(seed.ok).toBe(true);

    try {
      const before = await getCurrentConfigObject();
      const res = await rpcReq<{ ok?: boolean }>(requireWs(), "config.patch", {
        raw: JSON.stringify({ bindings: [bindings[1], makeRouteBinding(2)] }),
        baseHash: before.hash,
      });

      expect(res.ok).toBe(false);
      expect(res.error?.message ?? "").toContain(
        "config.patch would remove entries from array path(s): bindings",
      );
      const after = await getCurrentConfigObject();
      expect(after.hash).toBe(before.hash);
      expect(after.config.bindings).toEqual(bindings);
    } finally {
      await restoreConfigFileForTest(original);
    }
  });

  it("allows config.patch to append array entries without replacePaths", async () => {
    const original = await getCurrentConfigObject();
    const bindings = [0, 1].map(makeRouteBinding);
    const seededConfig = { ...original.config, bindings };
    const seed = await sendConfigApply(configRawPayload(seededConfig, original.hash));
    expect(seed.ok).toBe(true);

    try {
      const before = await getCurrentConfigObject();
      const nextBindings = [...bindings, makeRouteBinding(2)];
      const res = await rpcReq<{ ok?: boolean }>(requireWs(), "config.patch", {
        raw: JSON.stringify({ bindings: nextBindings }),
        baseHash: before.hash,
      });

      expect(res.ok).toBe(true);
      const after = await getCurrentConfigObject();
      expect(after.config.bindings).toEqual(nextBindings);
    } finally {
      await restoreConfigFileForTest(original);
    }
  });

  it("allows config.patch to shrink an existing array with replacePaths", async () => {
    const original = await getCurrentConfigObject();
    const bindings = [0, 1, 2].map(makeRouteBinding);
    const seededConfig = { ...original.config, bindings };
    const seed = await sendConfigApply(configRawPayload(seededConfig, original.hash));
    expect(seed.ok).toBe(true);

    try {
      const before = await getCurrentConfigObject();
      const replacement = [bindings[0]];
      const res = await rpcReq<{ ok?: boolean }>(requireWs(), "config.patch", {
        raw: JSON.stringify({ bindings: replacement }),
        baseHash: before.hash,
        replacePaths: ["bindings"],
      });

      expect(res.ok).toBe(true);
      const after = await getCurrentConfigObject();
      expect(after.config.bindings).toEqual(replacement);
    } finally {
      await restoreConfigFileForTest(original);
    }
  });

  it("accepts exact numeric record keys in replacePaths", async () => {
    const original = await getCurrentConfigObject();
    const channels =
      original.config.channels &&
      typeof original.config.channels === "object" &&
      !Array.isArray(original.config.channels)
        ? (original.config.channels as Record<string, unknown>)
        : {};
    const discord = {
      ...(channels.discord as Record<string, unknown> | undefined),
      allowFrom: ["*"],
      guilds: {
        "123": {
          channels: {
            general: {
              users: ["111", "222"],
            },
          },
        },
      },
    };
    const seed = await sendConfigApply(
      configRawPayload({ ...original.config, channels: { ...channels, discord } }, original.hash),
    );
    expect(seed.ok).toBe(true);

    try {
      const before = await getCurrentConfigObject();
      const res = await rpcReq<{ ok?: boolean }>(requireWs(), "config.patch", {
        raw: JSON.stringify({
          channels: {
            discord: {
              guilds: { "123": { channels: { general: { users: ["111"] } } } },
            },
          },
        }),
        baseHash: before.hash,
        replacePaths: ["channels.discord.guilds.123.channels.general.users"],
      });

      expect(res.ok).toBe(true);
      const after = await getCurrentConfigObject();
      const afterChannels = requireConfigObject(after.config.channels, "channels");
      expect(
        (
          afterChannels.discord as {
            guilds?: { "123"?: { channels?: { general?: { users?: unknown[] } } } };
          }
        ).guilds?.["123"]?.channels?.general?.users,
      ).toEqual(["111"]);
    } finally {
      await restoreConfigFileForTest(original);
    }
  });

  it("uses replacePaths to replace id-keyed arrays instead of merging by id", async () => {
    const original = await getCurrentConfigObject();
    const agents = {
      ...(original.config.agents as Record<string, unknown> | undefined),
      list: [makeAgentEntry("main", { default: true }), makeAgentEntry("worker")],
    };
    const seed = await sendConfigApply(
      configRawPayload({ ...original.config, agents }, original.hash),
    );
    expect(seed.ok).toBe(true);

    try {
      const before = await getCurrentConfigObject();
      const replacement = [makeAgentEntry("main", { default: true })];
      const res = await rpcReq<{ ok?: boolean }>(requireWs(), "config.patch", {
        raw: JSON.stringify({ agents: { list: replacement } }),
        baseHash: before.hash,
        replacePaths: ["agents.list"],
      });

      expect(res.ok).toBe(true);
      const after = await getCurrentConfigObject();
      expect((after.config.agents as { list?: unknown[] }).list).toEqual(replacement);
    } finally {
      await restoreConfigFileForTest(original);
    }
  });

  it("rejects nested destructive array patches inside id-keyed arrays without replacePaths", async () => {
    const original = await getCurrentConfigObject();
    const agents = {
      ...(original.config.agents as Record<string, unknown> | undefined),
      list: [
        makeAgentEntry("main", { default: true, skills: ["alpha", "beta"] }),
        makeAgentEntry("worker", { skills: ["gamma"] }),
      ],
    };
    const seed = await sendConfigApply(
      configRawPayload({ ...original.config, agents }, original.hash),
    );
    expect(seed.ok).toBe(true);

    try {
      const before = await getCurrentConfigObject();
      const res = await rpcReq<{ ok?: boolean }>(requireWs(), "config.patch", {
        raw: JSON.stringify({ agents: { list: [{ id: "main", skills: ["alpha"] }] } }),
        baseHash: before.hash,
      });

      expect(res.ok).toBe(false);
      expect(res.error?.message ?? "").toContain(
        "config.patch would remove entries from array path(s): agents.list[].skills",
      );
      const after = await getCurrentConfigObject();
      expect(after.hash).toBe(before.hash);
      expect((after.config.agents as { list?: unknown[] }).list).toEqual(agents.list);
    } finally {
      await restoreConfigFileForTest(original);
    }
  });

  it("rejects nested destructive array patches when replacePaths names only a parent object", async () => {
    const original = await getCurrentConfigObject();
    const agents = {
      ...(original.config.agents as Record<string, unknown> | undefined),
      list: [
        makeAgentEntry("main", { default: true, skills: ["alpha", "beta"] }),
        makeAgentEntry("worker", { skills: ["gamma"] }),
      ],
    };
    const seed = await sendConfigApply(
      configRawPayload({ ...original.config, agents }, original.hash),
    );
    expect(seed.ok).toBe(true);

    try {
      const before = await getCurrentConfigObject();
      const res = await rpcReq<{ ok?: boolean }>(requireWs(), "config.patch", {
        raw: JSON.stringify({ agents: { list: [{ id: "main", skills: ["alpha"] }] } }),
        baseHash: before.hash,
        replacePaths: ["agents"],
      });

      expect(res.ok).toBe(false);
      expect(res.error?.message ?? "").toContain(
        "config.patch would remove entries from array path(s): agents.list[].skills",
      );
      const after = await getCurrentConfigObject();
      expect(after.hash).toBe(before.hash);
      expect((after.config.agents as { list?: unknown[] }).list).toEqual(agents.list);
    } finally {
      await restoreConfigFileForTest(original);
    }
  });

  it("rejects deleting a parent object that contains arrays without replacePaths", async () => {
    const original = await getCurrentConfigObject();
    const agents = {
      ...(original.config.agents as Record<string, unknown> | undefined),
      list: [makeAgentEntry("main", { default: true }), makeAgentEntry("worker")],
    };
    const seed = await sendConfigApply(
      configRawPayload({ ...original.config, agents }, original.hash),
    );
    expect(seed.ok).toBe(true);

    try {
      const before = await getCurrentConfigObject();
      const res = await rpcReq<{ ok?: boolean }>(requireWs(), "config.patch", {
        raw: JSON.stringify({ agents: null }),
        baseHash: before.hash,
      });

      expect(res.ok).toBe(false);
      expect(res.error?.message ?? "").toContain(
        "config.patch would remove entries from array path(s): agents.list",
      );
      const after = await getCurrentConfigObject();
      expect(after.hash).toBe(before.hash);
    } finally {
      await restoreConfigFileForTest(original);
    }
  });

  it("rejects deleting a nested parent object inside id-keyed arrays without replacePaths", async () => {
    const original = await getCurrentConfigObject();
    const agents = {
      ...(original.config.agents as Record<string, unknown> | undefined),
      list: [
        makeAgentEntry("main", {
          default: true,
          subagents: { allowAgents: ["worker"] },
        }),
        makeAgentEntry("worker"),
      ],
    };
    const seed = await sendConfigApply(
      configRawPayload({ ...original.config, agents }, original.hash),
    );
    expect(seed.ok).toBe(true);

    try {
      const before = await getCurrentConfigObject();
      const res = await rpcReq<{ ok?: boolean }>(requireWs(), "config.patch", {
        raw: JSON.stringify({ agents: { list: [{ id: "main", subagents: null }] } }),
        baseHash: before.hash,
      });

      expect(res.ok).toBe(false);
      expect(res.error?.message ?? "").toContain(
        "config.patch would remove entries from array path(s): agents.list[].subagents.allowAgents",
      );
      const after = await getCurrentConfigObject();
      expect(after.hash).toBe(before.hash);
    } finally {
      await restoreConfigFileForTest(original);
    }
  });

  it("allows nested destructive array patches inside id-keyed arrays with replacePaths", async () => {
    const original = await getCurrentConfigObject();
    const agents = {
      ...(original.config.agents as Record<string, unknown> | undefined),
      list: [
        makeAgentEntry("main", { default: true, skills: ["alpha", "beta"] }),
        makeAgentEntry("worker", { skills: ["gamma"] }),
      ],
    };
    const seed = await sendConfigApply(
      configRawPayload({ ...original.config, agents }, original.hash),
    );
    expect(seed.ok).toBe(true);

    try {
      const before = await getCurrentConfigObject();
      const res = await rpcReq<{ ok?: boolean }>(requireWs(), "config.patch", {
        raw: JSON.stringify({ agents: { list: [{ id: "main", skills: ["alpha"] }] } }),
        baseHash: before.hash,
        replacePaths: ["agents.list[].skills"],
      });

      expect(res.ok).toBe(true);
      const after = await getCurrentConfigObject();
      expect((after.config.agents as { list?: unknown[] }).list).toEqual([
        makeAgentEntry("main", { default: true, skills: ["alpha"] }),
        makeAgentEntry("worker", { skills: ["gamma"] }),
      ]);
    } finally {
      await restoreConfigFileForTest(original);
    }
  });

  it("rejects config.patch when merged SecretRefs cannot resolve", async () => {
    const missingEnvVar = `OPENCLAW_MISSING_SECRETREF_PATCH_${Date.now()}`;
    deleteTestEnvValue(missingEnvVar);
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
    deleteTestEnvValue(missingEnvVar);
    const current = await getCurrentConfigObject();
    const nextConfig = configWithGatewayTokenSecretRef(current.config, missingEnvVar);

    const res = await sendConfigApply(
      configRawPayload(nextConfig, current.hash),
      CONFIG_SECRETREF_RPC_TIMEOUT_MS,
    );
    expect(res.ok).toBe(false);
    expect(res.error?.message ?? "").toContain("active SecretRef resolution failed");

    const after = await rpcReq<{
      hash?: string;
      raw?: string | null;
    }>(requireWs(), "config.get", {});
    expect(after.ok).toBe(true);
    expect(after.payload?.hash).toBe(current.hash);
    expect(after.payload?.raw).toBe(current.raw);
  });

  it("does not reject config.apply for unresolved auth-profile refs outside submitted config", async () => {
    const missingEnvVar = `OPENCLAW_MISSING_AUTH_PROFILE_REF_APPLY_${Date.now()}`;
    await writeUnresolvedAuthProfileTokenRef(missingEnvVar);

    const current = await getCurrentConfigObject();

    const res = await sendConfigApply(configRawPayload(current.config, current.hash));
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

    expect(
      loadSessionEntry({ agentId: "ops", sessionKey: "agent:ops:work", storePath })?.thinkingLevel,
    ).toBe("medium");
    expect(loadSessionEntry({ agentId: "ops", sessionKey: "main", storePath })).toBeUndefined();
  });
});
