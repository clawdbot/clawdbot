import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { __testing as restartTesting } from "../infra/restart.js";
import { withEnvAsync } from "../test-utils/env.js";
import "./test-helpers/fast-core-tools.js";
import { createGatewayTool } from "./tools/gateway-tool.js";
import { callGatewayTool } from "./tools/gateway.js";

const { callGatewayToolMock, readGatewayCallOptionsMock } = vi.hoisted(() => ({
  callGatewayToolMock: vi.fn(),
  readGatewayCallOptionsMock: vi.fn(() => ({})),
}));

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: callGatewayToolMock,
  readGatewayCallOptions: readGatewayCallOptionsMock,
}));

function requireGatewayTool(agentSessionKey?: string) {
  return createGatewayTool({
    ...(agentSessionKey ? { agentSessionKey } : {}),
    config: { commands: { restart: true } },
  });
}

function collectActionValues(schema: unknown, values: Set<string>): void {
  if (!schema || typeof schema !== "object") {
    return;
  }

  const record = schema as Record<string, unknown>;
  if (typeof record.const === "string") {
    values.add(record.const);
  }
  if (Array.isArray(record.enum)) {
    for (const value of record.enum) {
      if (typeof value === "string") {
        values.add(value);
      }
    }
  }
  if (Array.isArray(record.anyOf)) {
    for (const variant of record.anyOf) {
      collectActionValues(variant, values);
    }
  }
}

function expectConfigMutationCall(params: {
  callGatewayTool: {
    mock: {
      calls: Array<readonly unknown[]>;
    };
  };
  action: "config.apply" | "config.patch";
  raw: string;
  sessionKey: string;
}) {
  expect(params.callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
  expect(params.callGatewayTool).toHaveBeenCalledWith(
    params.action,
    expect.any(Object),
    expect.objectContaining({
      raw: params.raw.trim(),
      baseHash: "hash-1",
      sessionKey: params.sessionKey,
    }),
  );
}

describe("gateway tool", () => {
  beforeEach(() => {
    restartTesting.resetSigusr1State();
    callGatewayToolMock.mockClear();
    readGatewayCallOptionsMock.mockClear();
    callGatewayToolMock.mockImplementation(async (method: string) => {
      if (method === "config.get") {
        return {
          hash: "hash-1",
          config: {
            tools: {
              exec: {
                ask: "on-miss",
                security: "allowlist",
              },
            },
          },
        };
      }
      if (method === "config.schema.lookup") {
        return {
          path: "gateway.auth",
          schema: {
            type: "object",
          },
          hint: { label: "Gateway Auth" },
          hintPath: "gateway.auth",
          children: [
            {
              key: "token",
              path: "gateway.auth.token",
              type: "string",
              required: true,
              hasChildren: false,
              hint: { label: "Token", sensitive: true },
              hintPath: "gateway.auth.token",
            },
          ],
        };
      }
      return { ok: true };
    });
  });

  it("marks gateway as owner-only", async () => {
    const tool = requireGatewayTool();
    expect(tool.ownerOnly).toBe(true);
  });

  it("exposes restart and config actions in the gateway tool schema", async () => {
    const tool = requireGatewayTool();
    const parameters = tool.parameters as {
      properties?: Record<string, unknown>;
    };
    const values = new Set<string>();
    collectActionValues(parameters.properties?.action, values);

    expect([...values]).toEqual(
      expect.arrayContaining(["restart", "config.get", "config.patch", "config.apply"]),
    );
  });

  it("schedules SIGUSR1 restart", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const restartSignalKillCalls = () =>
      kill.mock.calls.filter(
        ([pid, signal]) => pid === process.pid && (signal === "SIGUSR1" || signal === undefined),
      );
    const sigusr1Handler = vi.fn();
    process.on("SIGUSR1", sigusr1Handler);
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-"));

    try {
      await withEnvAsync(
        { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_PROFILE: "isolated" },
        async () => {
          const tool = requireGatewayTool();

          const result = await tool.execute("call1", {
            action: "restart",
            delayMs: 0,
          });
          expect(result.details).toMatchObject({
            ok: true,
            pid: process.pid,
            signal: "SIGUSR1",
            delayMs: 0,
          });

          expect(restartSignalKillCalls()).toHaveLength(0);
          expect(sigusr1Handler).not.toHaveBeenCalled();
          await vi.waitFor(() => expect(sigusr1Handler).toHaveBeenCalledTimes(1), {
            interval: 1,
            timeout: 1_000,
          });
          expect(restartSignalKillCalls()).toHaveLength(0);

          const sentinelPath = path.join(stateDir, "restart-sentinel.json");
          const raw = await fs.readFile(sentinelPath, "utf-8");
          const parsed = JSON.parse(raw) as {
            payload?: { kind?: string; doctorHint?: string | null };
          };
          expect(parsed.payload?.kind).toBe("restart");
          expect(parsed.payload?.doctorHint).toBe(
            "Run: openclaw --profile isolated doctor --non-interactive",
          );
        },
      );
    } finally {
      process.removeListener("SIGUSR1", sigusr1Handler);
      kill.mockRestore();
      restartTesting.resetSigusr1State();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("passes config.apply through gateway call", async () => {
    vi.mocked(callGatewayTool).mockImplementation(async (method: string) => {
      if (method === "config.get") {
        return {
          hash: "hash-1",
          config: {
            tools: {
              exec: {
                ask: "on-miss",
                security: "allowlist",
              },
            },
          },
        };
      }
      if (method === "config.apply") {
        return {
          ok: true,
          path: "/tmp/openclaw.json",
          config: { agents: { defaults: { systemPromptOverride: "You are a terse assistant." } } },
          restart: { ok: true, config: "nested field preserved" },
        };
      }
      return { ok: true };
    });
    const sessionKey = "agent:main:whatsapp:dm:+15555550123";
    const tool = requireGatewayTool(sessionKey);

    const raw =
      '{\n  agents: { defaults: { systemPromptOverride: "You are a terse assistant." } },\n  tools: { exec: { ask: "on-miss", security: "allowlist" } }\n}\n';
    const result = await tool.execute("call2", {
      action: "config.apply",
      raw,
    });

    expect(result.details).toEqual({
      ok: true,
      result: {
        ok: true,
        path: "/tmp/openclaw.json",
        restart: { ok: true, config: "nested field preserved" },
      },
    });
    expectConfigMutationCall({
      callGatewayTool: vi.mocked(callGatewayTool),
      action: "config.apply",
      raw,
      sessionKey,
    });
  });

  it("passes config.patch through gateway call", async () => {
    vi.mocked(callGatewayTool).mockImplementation(async (method: string) => {
      if (method === "config.get") {
        return {
          hash: "hash-1",
          config: {
            tools: {
              exec: {
                ask: "on-miss",
                security: "allowlist",
              },
            },
          },
        };
      }
      if (method === "config.patch") {
        return {
          ok: true,
          noop: true,
          path: "/tmp/openclaw.json",
          config: { channels: { telegram: { groups: {} } } },
        };
      }
      return { ok: true };
    });
    const sessionKey = "agent:main:whatsapp:dm:+15555550123";
    const tool = requireGatewayTool(sessionKey);

    const raw = '{\n  channels: { telegram: { groups: { "*": { requireMention: false } } } }\n}\n';
    const result = await tool.execute("call4", {
      action: "config.patch",
      raw,
    });

    expect(result.details).toEqual({
      ok: true,
      result: {
        ok: true,
        noop: true,
        path: "/tmp/openclaw.json",
      },
    });
    expectConfigMutationCall({
      callGatewayTool: vi.mocked(callGatewayTool),
      action: "config.patch",
      raw,
      sessionKey,
    });
  });

  it("rejects config.patch when it changes exec approval settings", async () => {
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-protected-patch", {
        action: "config.patch",
        raw: '{ tools: { exec: { ask: "off" } } }',
      }),
    ).rejects.toThrow("gateway config.patch cannot change protected config paths: tools.exec.ask");
    expect(callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.patch",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("rejects config.patch when it changes safe bin approval paths", async () => {
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-protected-safe-bins-patch", {
        action: "config.patch",
        raw: '{ tools: { exec: { safeBins: ["bash"], safeBinProfiles: { bash: { allowedValueFlags: ["-c"] } } } } }',
      }),
    ).rejects.toThrow(
      "gateway config.patch cannot change protected config paths: tools.exec.safeBinProfiles.bash.allowedValueFlags, tools.exec.safeBins",
    );
    expect(callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.patch",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("passes config.patch through gateway call when protected exec arrays and objects are unchanged", async () => {
    vi.mocked(callGatewayTool).mockImplementationOnce(async (method: string) => {
      if (method === "config.get") {
        return {
          hash: "hash-1",
          config: {
            tools: {
              exec: {
                ask: "on-miss",
                security: "allowlist",
                safeBins: ["bash"],
                safeBinProfiles: {
                  bash: {
                    allowedValueFlags: ["-c"],
                  },
                },
                safeBinTrustedDirs: ["/tmp/openclaw-bin"],
                strictInlineEval: true,
              },
            },
          },
        };
      }
      return { ok: true };
    });
    const tool = requireGatewayTool("agent:main:whatsapp:dm:+15555550123");

    const raw = `{
      tools: {
        exec: {
          safeBins: ["bash"],
          safeBinProfiles: {
            bash: {
              allowedValueFlags: ["-c"],
            },
          },
          safeBinTrustedDirs: ["/tmp/openclaw-bin"],
          strictInlineEval: true,
        },
      },
    }`;
    await tool.execute("call-same-protected-patch", {
      action: "config.patch",
      raw,
    });

    expectConfigMutationCall({
      callGatewayTool: vi.mocked(callGatewayTool),
      action: "config.patch",
      raw,
      sessionKey: "agent:main:whatsapp:dm:+15555550123",
    });
  });

  it("rejects config.patch when it changes strict inline eval directly", async () => {
    vi.mocked(callGatewayTool).mockImplementationOnce(async (method: string) => {
      if (method === "config.get") {
        return { hash: "hash-1", config: {} };
      }
      return { ok: true };
    });
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-protected-inline-eval-direct", {
        action: "config.patch",
        raw: "{ tools: { exec: { strictInlineEval: false } } }",
      }),
    ).rejects.toThrow(
      "gateway config.patch cannot change protected config paths: tools.exec.strictInlineEval",
    );
    expect(callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.patch",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("rejects config.patch when a legacy tools.bash alias changes strict inline eval", async () => {
    vi.mocked(callGatewayTool).mockImplementationOnce(async (method: string) => {
      if (method === "config.get") {
        return { hash: "hash-1", config: {} };
      }
      return { ok: true };
    });
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-legacy-protected-inline-eval", {
        action: "config.patch",
        raw: "{ tools: { bash: { strictInlineEval: false } } }",
      }),
    ).rejects.toThrow(
      "gateway config.patch cannot change protected config paths: tools.exec.strictInlineEval",
    );
    expect(callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.patch",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("rejects config.patch when a legacy tools.bash alias changes exec security", async () => {
    vi.mocked(callGatewayTool).mockImplementationOnce(async (method: string) => {
      if (method === "config.get") {
        return { hash: "hash-1", config: {} };
      }
      return { ok: true };
    });
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-legacy-protected-patch", {
        action: "config.patch",
        raw: '{ tools: { bash: { security: "full" } } }',
      }),
    ).rejects.toThrow(
      "gateway config.patch cannot change protected config paths: tools.exec.security",
    );
    expect(callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.patch",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("rejects config.apply when it changes exec security settings", async () => {
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-protected-apply", {
        action: "config.apply",
        raw: '{ tools: { exec: { ask: "on-miss", security: "full" } } }',
      }),
    ).rejects.toThrow(
      "gateway config.apply cannot change protected config paths: tools.exec.security",
    );
    expect(callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.apply",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("rejects config.apply when protected exec settings are omitted", async () => {
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-missing-protected", {
        action: "config.apply",
        raw: '{ agents: { defaults: { systemPromptOverride: "You are a terse assistant." } } }',
      }),
    ).rejects.toThrow(
      "gateway config.apply cannot change protected config paths: tools.exec.ask, tools.exec.security",
    );
    expect(callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.apply",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("rejects config.apply when it changes safe bin trusted directories", async () => {
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-protected-safe-bin-trust-apply", {
        action: "config.apply",
        raw: '{ tools: { exec: { ask: "on-miss", security: "allowlist", safeBinTrustedDirs: ["/tmp/openclaw-bin"] } } }',
      }),
    ).rejects.toThrow(
      "gateway config.apply cannot change protected config paths: tools.exec.safeBinTrustedDirs",
    );
    expect(callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.apply",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("rejects config.patch when it rewrites gateway.remote.url", async () => {
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-remote-redirect", {
        action: "config.patch",
        raw: '{ gateway: { remote: { url: "wss://attacker.example/collect" } } }',
      }),
    ).rejects.toThrow(
      "gateway config.patch cannot change protected config paths: gateway.remote.url",
    );
    expect(callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.patch",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("rejects config.patch when it rewrites global tools policy", async () => {
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-tools-policy", {
        action: "config.patch",
        raw: '{ tools: { allow: ["exec"], elevated: { enabled: true } } }',
      }),
    ).rejects.toThrow(
      "gateway config.patch cannot change protected config paths: tools.allow, tools.elevated.enabled",
    );
    expect(callGatewayTool).toHaveBeenCalledWith("config.get", expect.any(Object), {});
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.patch",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("rejects config.patch that enables dangerouslyDisableDeviceAuth", async () => {
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-dangerous-device-auth", {
        action: "config.patch",
        raw: "{ gateway: { controlUi: { dangerouslyDisableDeviceAuth: true } } }",
      }),
    ).rejects.toThrow(
      "gateway config.patch cannot change protected config paths: gateway.controlUi.dangerouslyDisableDeviceAuth",
    );
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.patch",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("rejects config.patch that enables allowUnsafeExternalContent on gmail hooks", async () => {
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-dangerous-gmail", {
        action: "config.patch",
        raw: "{ hooks: { gmail: { allowUnsafeExternalContent: true } } }",
      }),
    ).rejects.toThrow(
      "gateway config.patch cannot change protected config paths: hooks.gmail.allowUnsafeExternalContent",
    );
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.patch",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("rejects config.patch that weakens applyPatch.workspaceOnly", async () => {
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-dangerous-workspace", {
        action: "config.patch",
        raw: "{ tools: { exec: { applyPatch: { workspaceOnly: false } } } }",
      }),
    ).rejects.toThrow(
      "gateway config.patch cannot change protected config paths: tools.exec.applyPatch.workspaceOnly",
    );
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.patch",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("rejects config.patch that enables allowInsecureAuth on control UI", async () => {
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-dangerous-insecure-auth", {
        action: "config.patch",
        raw: "{ gateway: { controlUi: { allowInsecureAuth: true } } }",
      }),
    ).rejects.toThrow(
      "gateway config.patch cannot change protected config paths: gateway.controlUi.allowInsecureAuth",
    );
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.patch",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("rejects config.patch that enables dangerouslyAllowHostHeaderOriginFallback", async () => {
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-dangerous-origin-fallback", {
        action: "config.patch",
        raw: "{ gateway: { controlUi: { dangerouslyAllowHostHeaderOriginFallback: true } } }",
      }),
    ).rejects.toThrow(
      "gateway config.patch cannot change protected config paths: gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback",
    );
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.patch",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("allows config.patch that does not enable any dangerous flag", async () => {
    const sessionKey = "agent:main:whatsapp:dm:+15555550123";
    const tool = requireGatewayTool(sessionKey);

    const raw = '{ channels: { telegram: { groups: { "*": { requireMention: false } } } } }';
    await tool.execute("call-safe-patch", {
      action: "config.patch",
      raw,
    });

    expect(callGatewayTool).toHaveBeenCalledWith(
      "config.patch",
      expect.any(Object),
      expect.objectContaining({ raw: raw.trim() }),
    );
  });

  it("allows config.patch on allowlisted paths when a dangerous flag is already enabled", async () => {
    vi.mocked(callGatewayTool).mockImplementationOnce(async (method: string) => {
      if (method === "config.get") {
        return {
          hash: "hash-1",
          config: {
            tools: { exec: { ask: "on-miss", security: "allowlist" } },
            hooks: { gmail: { allowUnsafeExternalContent: true } },
          },
        };
      }
      return { ok: true };
    });
    const sessionKey = "agent:main:whatsapp:dm:+15555550123";
    const tool = requireGatewayTool(sessionKey);

    const raw = '{ agents: { defaults: { systemPromptOverride: "You are a terse assistant." } } }';
    await tool.execute("call-keep-dangerous", {
      action: "config.patch",
      raw,
    });

    expect(callGatewayTool).toHaveBeenCalledWith(
      "config.patch",
      expect.any(Object),
      expect.objectContaining({ raw: raw.trim() }),
    );
  });

  it("rejects config.apply that introduces a dangerous flag", async () => {
    const tool = requireGatewayTool();

    await expect(
      tool.execute("call-dangerous-apply", {
        action: "config.apply",
        raw: '{ tools: { exec: { ask: "on-miss", security: "allowlist", applyPatch: { workspaceOnly: false } } } }',
      }),
    ).rejects.toThrow(
      "gateway config.apply cannot change protected config paths: tools.exec.applyPatch.workspaceOnly",
    );
    expect(callGatewayTool).not.toHaveBeenCalledWith(
      "config.apply",
      expect.any(Object),
      expect.anything(),
    );
  });

  it("passes update.run through gateway call", async () => {
    const sessionKey = "agent:main:whatsapp:dm:+15555550123";
    const tool = requireGatewayTool(sessionKey);

    await tool.execute("call3", {
      action: "update.run",
      note: "test update",
    });

    expect(callGatewayTool).toHaveBeenCalledWith(
      "update.run",
      expect.any(Object),
      expect.objectContaining({
        note: "test update",
        sessionKey,
      }),
    );
    const updateCall = vi
      .mocked(callGatewayTool)
      .mock.calls.find((call) => call[0] === "update.run");
    expect(updateCall).toBeDefined();
    if (updateCall) {
      const [, opts, params] = updateCall;
      expect(opts).toMatchObject({ timeoutMs: 20 * 60_000 });
      expect(params).toMatchObject({ timeoutMs: 20 * 60_000 });
    }
  });

  it("returns a path-scoped schema lookup result", async () => {
    const tool = requireGatewayTool();

    const result = await tool.execute("call5", {
      action: "config.schema.lookup",
      path: "gateway.auth",
    });

    expect(callGatewayTool).toHaveBeenCalledWith("config.schema.lookup", expect.any(Object), {
      path: "gateway.auth",
    });
    expect(result.details).toMatchObject({
      ok: true,
      result: {
        path: "gateway.auth",
        hintPath: "gateway.auth",
        children: [
          expect.objectContaining({
            key: "token",
            path: "gateway.auth.token",
            required: true,
            hintPath: "gateway.auth.token",
          }),
        ],
      },
    });
    const schema = (result.details as { result?: { schema?: { properties?: unknown } } }).result
      ?.schema;
    expect(schema?.properties).toBeUndefined();
  });
});
