import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const note = vi.hoisted(() => vi.fn());
const pluginRegistry = vi.hoisted(() => ({ list: [] as unknown[] }));
const listReadOnlyChannelPluginsForConfigMock = vi.hoisted(() => vi.fn());

vi.mock("../terminal/note.js", () => ({
  note,
}));

vi.mock("../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfig: listReadOnlyChannelPluginsForConfigMock,
}));

vi.mock("../channels/read-only-account-inspect.js", () => ({
  inspectReadOnlyChannelAccount: vi.fn(async () => null),
}));

import { noteSecurityWarnings } from "./doctor-security.js";

describe("noteSecurityWarnings gateway exposure", () => {
  let prevToken: string | undefined;
  let prevPassword: string | undefined;
  let prevHome: string | undefined;
  let prevServiceKind: string | undefined;

  beforeEach(() => {
    note.mockClear();
    listReadOnlyChannelPluginsForConfigMock.mockReset();
    listReadOnlyChannelPluginsForConfigMock.mockImplementation(() => pluginRegistry.list);
    pluginRegistry.list = [];
    prevToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    prevPassword = process.env.OPENCLAW_GATEWAY_PASSWORD;
    prevHome = process.env.HOME;
    prevServiceKind = process.env.OPENCLAW_SERVICE_KIND;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_GATEWAY_PASSWORD;
    delete process.env.OPENCLAW_SERVICE_KIND;
  });

  afterEach(() => {
    if (prevToken === undefined) {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
    } else {
      process.env.OPENCLAW_GATEWAY_TOKEN = prevToken;
    }
    if (prevPassword === undefined) {
      delete process.env.OPENCLAW_GATEWAY_PASSWORD;
    } else {
      process.env.OPENCLAW_GATEWAY_PASSWORD = prevPassword;
    }
    if (prevHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = prevHome;
    }
    if (prevServiceKind === undefined) {
      delete process.env.OPENCLAW_SERVICE_KIND;
    } else {
      process.env.OPENCLAW_SERVICE_KIND = prevServiceKind;
    }
  });

  const lastMessage = () => String(note.mock.calls.at(-1)?.[0] ?? "");

  async function withExecApprovalsFile(
    file: Record<string, unknown>,
    run: () => Promise<void>,
  ): Promise<void> {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-security-"));
    process.env.HOME = home;
    await fs.mkdir(path.join(home, ".openclaw"), { recursive: true });
    await fs.writeFile(
      path.join(home, ".openclaw", "exec-approvals.json"),
      JSON.stringify(file, null, 2),
    );
    await run();
  }

  async function expectAgentExecHostPolicyWarning(agentKey: "*" | "runner") {
    await withExecApprovalsFile(
      {
        version: 1,
        defaults:
          agentKey === "*"
            ? {
                security: "full",
                ask: "off",
              }
            : undefined,
        agents: {
          [agentKey]: {
            security: "allowlist",
            ask: "always",
          },
        },
      },
      async () => {
        await noteSecurityWarnings({
          agents: {
            list: [
              {
                id: "runner",
                tools: {
                  exec: {
                    security: "full",
                    ask: "off",
                  },
                },
              },
            ],
          },
        } as OpenClawConfig);
      },
    );

    const message = lastMessage();
    expect(message).toContain("agents.list.runner.tools.exec is broader than the host exec policy");
    expect(message).toContain(`agents.${agentKey}.security="allowlist"`);
    expect(message).toContain(`agents.${agentKey}.ask="always"`);
  }

  it("warns when exposed without auth", async () => {
    const cfg = { gateway: { bind: "lan" } } as OpenClawConfig;
    await noteSecurityWarnings(cfg);
    const message = lastMessage();
    expect(message).toContain("CRITICAL");
    expect(message).toContain("without authentication");
    expect(message).toContain("Safer remote access");
    expect(message).toContain("ssh -N -L 18789:127.0.0.1:18789");
  });

  it("uses env token to avoid critical warning", async () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = "token-123";
    const cfg = { gateway: { bind: "lan" } } as OpenClawConfig;
    await noteSecurityWarnings(cfg);
    const message = lastMessage();
    expect(message).toContain("WARNING");
    expect(message).not.toContain("CRITICAL");
  });

  it("treats SecretRef token config as authenticated for exposure warning level", async () => {
    const cfg = {
      gateway: {
        bind: "lan",
        auth: {
          mode: "token",
          token: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_TOKEN" },
        },
      },
    } as OpenClawConfig;
    await noteSecurityWarnings(cfg);
    const message = lastMessage();
    expect(message).toContain("WARNING");
    expect(message).not.toContain("CRITICAL");
  });

  it("warns when OPENCLAW_GATEWAY_TOKEN env conflicts with gateway.auth.token config (#74271)", async () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = "env-token-123";
    const cfg = {
      gateway: {
        auth: {
          token: "config-token-456",
        },
      },
    } as OpenClawConfig;
    await noteSecurityWarnings(cfg);
    const message = lastMessage();
    expect(message).toContain("OPENCLAW_GATEWAY_TOKEN conflicts with gateway.auth.token");
    expect(message).toContain("Direct local Gateway clients commonly prefer the env token");
    expect(message).toContain("~/.openclaw/.env");
  });

  it("does not warn when only env token is set without config token", async () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = "env-token-only";
    const cfg = { gateway: { bind: "lan" } } as OpenClawConfig;
    await noteSecurityWarnings(cfg);
    const message = lastMessage();
    expect(message).not.toContain("OPENCLAW_GATEWAY_TOKEN overrides");
  });

  it("does not warn inside the managed gateway service credential context", async () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = "env-token-123";
    process.env.OPENCLAW_SERVICE_KIND = "gateway";
    const cfg = {
      gateway: {
        auth: {
          token: "config-token-456",
        },
      },
    } as OpenClawConfig;
    await noteSecurityWarnings(cfg);
    const message = lastMessage();
    expect(message).not.toContain("OPENCLAW_GATEWAY_TOKEN conflicts");
  });

  it("does not warn when config token uses OPENCLAW_GATEWAY_TOKEN SecretRef", async () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = "env-token-123";
    const cfg = {
      gateway: { auth: { token: "${OPENCLAW_GATEWAY_TOKEN}" } },
      secrets: { providers: { default: { source: "env" } } },
    } as OpenClawConfig;
    await noteSecurityWarnings(cfg);
    const message = lastMessage();
    expect(message).not.toContain("OPENCLAW_GATEWAY_TOKEN overrides");
  });

  it("does not warn about local gateway auth token precedence in remote mode", async () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = "env-token-123";
    const cfg = {
      gateway: {
        mode: "remote",
        remote: { token: "remote-token" },
        auth: { token: "local-token" },
      },
    } as OpenClawConfig;
    await noteSecurityWarnings(cfg);
    const message = lastMessage();
    expect(message).not.toContain("OPENCLAW_GATEWAY_TOKEN overrides");
  });

  it("treats whitespace token as missing", async () => {
    const cfg = {
      gateway: { bind: "lan", auth: { mode: "token", token: "   " } },
    } as OpenClawConfig;
    await noteSecurityWarnings(cfg);
    const message = lastMessage();
    expect(message).toContain("CRITICAL");
  });

  it("skips warning for loopback bind", async () => {
    const cfg = { gateway: { bind: "loopback" } } as OpenClawConfig;
    await noteSecurityWarnings(cfg);
    const message = lastMessage();
    expect(message).toContain("No channel security warnings detected");
    expect(message).not.toContain("Gateway bound");
  });

  it("treats unset bind as loopback for host-side doctor checks", async () => {
    const cfg = { gateway: {} } as OpenClawConfig;
    await noteSecurityWarnings(cfg);
    const message = lastMessage();
    expect(message).toContain("No channel security warnings detected");
    expect(message).not.toContain("Gateway bound");
  });

  it("shows explicit dmScope config command for multi-user DMs", async () => {
    pluginRegistry.list = [
      {
        id: "test-channel",
        meta: { label: "Test Channel" },
        config: {
          listAccountIds: () => ["default"],
          inspectAccount: () => ({ enabled: true, configured: true }),
          resolveAccount: () => ({}),
          isEnabled: () => true,
          isConfigured: () => true,
        },
        security: {
          resolveDmPolicy: () => ({
            policy: "allowlist",
            allowFrom: ["alice", "bob"],
            allowFromPath: "channels.whatsapp.",
            approveHint: "approve",
          }),
        },
      },
    ];
    const cfg = { session: { dmScope: "main" } } as OpenClawConfig;
    await noteSecurityWarnings(cfg);
    expect(listReadOnlyChannelPluginsForConfigMock).toHaveBeenCalledWith(cfg, {
      includePersistedAuthState: true,
      includeSetupFallbackPlugins: true,
    });
    const message = lastMessage();
    expect(message).toContain('config set session.dmScope "per-channel-peer"');
  });

  it("clarifies approvals.exec forwarding-only behavior", async () => {
    const cfg = {
      approvals: {
        exec: {
          enabled: false,
        },
      },
    } as OpenClawConfig;
    await noteSecurityWarnings(cfg);
    const message = lastMessage();
    expect(message).toContain("disables approval forwarding only");
    expect(message).toContain("exec-approvals.json");
    expect(message).toContain("openclaw approvals get --gateway");
  });

  it("warns when filesystem tools are disabled but exec remains available", async () => {
    await noteSecurityWarnings({
      tools: {
        allow: ["read", "exec", "process"],
        deny: ["write", "edit", "apply_patch"],
      },
    } as OpenClawConfig);

    const message = lastMessage();
    expect(message).toContain("filesystem write tools are disabled, but exec is still available");
    expect(message).toContain("Runtime tools: exec, process");
    expect(message).toContain('sandbox.mode="off"');
    expect(message).toContain("also deny exec/process");
  });

  it("does not warn about exec filesystem policy when sandbox access is read-only", async () => {
    await noteSecurityWarnings({
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            workspaceAccess: "ro",
          },
        },
      },
      tools: {
        allow: ["read", "exec", "process"],
        deny: ["write", "edit", "apply_patch"],
      },
    } as OpenClawConfig);

    const message = lastMessage();
    expect(message).not.toContain(
      "filesystem write tools are disabled, but exec is still available",
    );
  });

  it("warns when tools.exec is broader than host exec defaults", async () => {
    await withExecApprovalsFile(
      {
        version: 1,
        defaults: {
          security: "allowlist",
          ask: "on-miss",
        },
      },
      async () => {
        await noteSecurityWarnings({
          tools: {
            exec: {
              security: "full",
              ask: "off",
            },
          },
        } as OpenClawConfig);
      },
    );

    const message = lastMessage();
    expect(message).toContain("tools.exec is broader than the host exec policy");
    expect(message).toContain('security="full"');
    expect(message).toContain('defaults.security="allowlist"');
    expect(message).toContain("stricter side wins");
  });

  it("attributes broader host policy warnings to wildcard agent entries", async () => {
    await expectAgentExecHostPolicyWarning("*");
  });

  it("does not invent a deny host policy when exec-approvals defaults.security is unset", async () => {
    await withExecApprovalsFile(
      {
        version: 1,
        agents: {},
      },
      async () => {
        await noteSecurityWarnings({
          tools: {
            exec: {
              security: "allowlist",
              ask: "on-miss",
            },
          },
        } as OpenClawConfig);
      },
    );

    const message = lastMessage();
    expect(message).toContain("No channel security warnings detected");
    expect(message).not.toContain('security="deny"');
  });

  it("does not invent an on-miss host ask policy when exec-approvals defaults.ask is unset", async () => {
    await withExecApprovalsFile(
      {
        version: 1,
        agents: {},
      },
      async () => {
        await noteSecurityWarnings({
          tools: {
            exec: {
              ask: "always",
            },
          },
        } as OpenClawConfig);
      },
    );

    const message = lastMessage();
    expect(message).toContain("No channel security warnings detected");
    expect(message).not.toContain('ask="on-miss"');
  });

  it("warns when a per-agent exec policy is broader than the matching host agent policy", async () => {
    await expectAgentExecHostPolicyWarning("runner");
  });

  it("warns when an agent inherits broader global tools.exec policy than the matching host agent policy", async () => {
    await withExecApprovalsFile(
      {
        version: 1,
        agents: {
          runner: {
            security: "allowlist",
            ask: "always",
          },
        },
      },
      async () => {
        await noteSecurityWarnings({
          tools: {
            exec: {
              security: "full",
              ask: "off",
            },
          },
          agents: {
            list: [{ id: "runner" }],
          },
        } as OpenClawConfig);
      },
    );

    const message = lastMessage();
    expect(message).toContain("agents.list.runner.tools.exec is broader than the host exec policy");
    expect(message).toContain('tools.exec.security="full"');
    expect(message).toContain('tools.exec.ask="off"');
    expect(message).toContain('agents.runner.security="allowlist"');
    expect(message).toContain('agents.runner.ask="always"');
  });

  it("ignores malformed host policy fields when attributing doctor conflicts", async () => {
    await withExecApprovalsFile(
      {
        version: 1,
        defaults: {
          ask: "always",
        },
        agents: {
          runner: {
            ask: "foo",
          },
        },
      },
      async () => {
        await noteSecurityWarnings({
          tools: {
            exec: {
              ask: "off",
            },
          },
          agents: {
            list: [{ id: "runner" }],
          },
        } as OpenClawConfig);
      },
    );

    const message = lastMessage();
    expect(message).toContain("agents.list.runner.tools.exec is broader than the host exec policy");
    expect(message).toContain('defaults.ask="always"');
    expect(message).not.toContain('agents.runner.ask="foo"');
  });

  it('does not warn about durable allow-always trust when ask="always" is enforced', async () => {
    await withExecApprovalsFile(
      {
        version: 1,
        defaults: {
          ask: "always",
        },
        agents: {
          main: {
            allowlist: [
              {
                pattern: "/usr/bin/echo",
                source: "allow-always",
              },
            ],
          },
        },
      },
      async () => {
        await noteSecurityWarnings({
          tools: {
            exec: {
              ask: "always",
            },
          },
        } as OpenClawConfig);
      },
    );

    const message = lastMessage();
    expect(message).not.toContain('tools.exec: ask="always" still bypasses future prompts');
  });

  it("warns when heartbeat delivery relies on implicit directPolicy defaults", async () => {
    const cfg = {
      agents: {
        defaults: {
          heartbeat: {
            target: "last",
          },
        },
      },
    } as OpenClawConfig;
    await noteSecurityWarnings(cfg);
    const message = lastMessage();
    expect(message).toContain("Heartbeat defaults");
    expect(message).toContain("agents.defaults.heartbeat.directPolicy");
    expect(message).toContain("direct/DM targets by default");
  });

  it("warns when a per-agent heartbeat relies on implicit directPolicy", async () => {
    const cfg = {
      agents: {
        list: [
          {
            id: "ops",
            heartbeat: {
              target: "last",
            },
          },
        ],
      },
    } as OpenClawConfig;
    await noteSecurityWarnings(cfg);
    const message = lastMessage();
    expect(message).toContain('Heartbeat agent "ops"');
    expect(message).toContain('heartbeat.directPolicy for agent "ops"');
    expect(message).toContain("direct/DM targets by default");
  });

  it("degrades safely when channel account resolution fails in read-only security checks", async () => {
    pluginRegistry.list = [
      {
        id: "whatsapp",
        meta: { label: "WhatsApp" },
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => {
            throw new Error("missing secret");
          },
          isEnabled: () => true,
          isConfigured: () => true,
        },
        security: {
          resolveDmPolicy: () => null,
        },
      },
    ];

    await noteSecurityWarnings({} as OpenClawConfig);
    expect(listReadOnlyChannelPluginsForConfigMock).toHaveBeenCalledWith(
      {},
      {
        includePersistedAuthState: true,
        includeSetupFallbackPlugins: true,
      },
    );
    const message = lastMessage();
    expect(message).toContain("[secrets]");
    expect(message).toContain("failed to resolve account");
    expect(message).toContain("Run: openclaw security audit --deep");
  });

  it("skips heartbeat directPolicy warning when delivery is internal-only or explicit", async () => {
    const cfg = {
      agents: {
        defaults: {
          heartbeat: {
            target: "none",
          },
        },
        list: [
          {
            id: "ops",
            heartbeat: {
              target: "last",
              directPolicy: "block",
            },
          },
        ],
      },
    } as OpenClawConfig;
    await noteSecurityWarnings(cfg);
    const message = lastMessage();
    expect(message).not.toContain("Heartbeat defaults");
    expect(message).not.toContain('Heartbeat agent "ops"');
  });
});
