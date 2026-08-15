// Doctor security tests cover security audit checks, config findings, and repair output.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ExecApprovalsFile } from "../infra/exec-approvals-core.js";
import { saveExecApprovals } from "../infra/exec-approvals-store.js";
import { testing as execApprovalsStoreTesting } from "../infra/exec-approvals-store.test-support.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withTestDir } from "../test-helpers/temp-dir.js";

const note = vi.hoisted(() => vi.fn());
const pluginRegistry = vi.hoisted(() => ({ list: [] as unknown[] }));
const listReadOnlyChannelPluginsForConfigMock = vi.hoisted(() => vi.fn());

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note,
}));

vi.mock("../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfig: listReadOnlyChannelPluginsForConfigMock,
}));

vi.mock("../channels/read-only-account-inspect.js", () => ({
  inspectReadOnlyChannelAccount: vi.fn(async () => null),
}));

// These doctor assertions cover core secret fields. Registry integration tests
// own plugin-derived targets, so avoid compiling every bundled plugin here.
vi.mock("../secrets/target-registry-data.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../secrets/target-registry-data.js")>();
  return {
    ...actual,
    getSecretTargetRegistry: actual.getCoreSecretTargetRegistry,
  };
});

import { noteSecurityWarnings } from "./doctor-security.js";

describe("noteSecurityWarnings gateway exposure", () => {
  let prevToken: string | undefined;
  let prevPassword: string | undefined;
  let prevHome: string | undefined;
  let prevStateDir: string | undefined;
  let prevServiceKind: string | undefined;

  beforeEach(() => {
    note.mockClear();
    listReadOnlyChannelPluginsForConfigMock.mockReset();
    listReadOnlyChannelPluginsForConfigMock.mockImplementation(() => pluginRegistry.list);
    pluginRegistry.list = [];
    prevToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    prevPassword = process.env.OPENCLAW_GATEWAY_PASSWORD;
    prevHome = process.env.HOME;
    prevStateDir = process.env.OPENCLAW_STATE_DIR;
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
    if (prevStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = prevStateDir;
    }
    if (prevServiceKind === undefined) {
      delete process.env.OPENCLAW_SERVICE_KIND;
    } else {
      process.env.OPENCLAW_SERVICE_KIND = prevServiceKind;
    }
  });

  const lastMessage = () => String(note.mock.calls[note.mock.calls.length - 1]?.[0] ?? "");

  async function withExecApprovalsFile(
    file: Record<string, unknown>,
    run: () => Promise<void>,
  ): Promise<void> {
    await withTestDir({ prefix: "openclaw-doctor-security-" }, async (home) => {
      process.env.HOME = home;
      process.env.OPENCLAW_STATE_DIR = path.join(home, ".openclaw");
      closeOpenClawStateDatabaseForTest();
      execApprovalsStoreTesting.reset();
      saveExecApprovals(file as ExecApprovalsFile);
      try {
        await run();
      } finally {
        closeOpenClawStateDatabaseForTest();
        execApprovalsStoreTesting.reset();
      }
    });
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
            entries: {
              runner: {
                tools: {
                  exec: {
                    mode: "full",
                  },
                },
              },
            },
          },
        } as OpenClawConfig);
      },
    );

    const message = lastMessage();
    expect(message).toContain(
      "agents.entries.runner.tools.exec is broader than the host exec policy",
    );
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
    expect(message).toContain("openclaw security audit --deep");
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
    expect(message).toContain("Configured local Gateway clients");
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
    expect(note).not.toHaveBeenCalled();
  });

  it("treats unset bind as loopback for host-side doctor checks", async () => {
    const cfg = { gateway: {} } as OpenClawConfig;
    await noteSecurityWarnings(cfg);
    expect(note).not.toHaveBeenCalled();
  });

  it("renders the structured non-default-account DM collision guidance", async () => {
    pluginRegistry.list = [
      {
        id: "test-channel",
        meta: { label: "Test Channel" },
        config: {
          listAccountIds: () => ["default", "secondary"],
          defaultAccountId: () => "default",
          inspectAccount: (_cfg: OpenClawConfig, accountId: string) => ({
            accountId,
            enabled: true,
            configured: true,
          }),
          resolveAccount: (_cfg: OpenClawConfig, accountId: string) => ({ accountId }),
          isEnabled: () => true,
          isConfigured: () => true,
        },
        security: {
          resolveDmPolicy: ({ accountId }: { accountId?: string | null }) => ({
            policy: "allowlist",
            allowFrom: accountId === "secondary" ? ["alice", "bob"] : ["owner"],
            allowFromPath: `channels.test-channel.accounts.${accountId}.`,
            approveHint: "approve",
          }),
          collectWarnings: () => ["- plugin warning remains visible"],
          collectAuditFindings: () => [
            {
              checkId: "channels.test-channel.audit_only",
              severity: "warn",
              title: "audit-only plugin finding",
              detail: "must not appear in Doctor",
            },
          ],
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
    expect(message).toContain("matching binding or session.dmScope");
    expect(message).toContain("secondary");
    expect(message).toContain("plugin warning remains visible");
    expect(message).not.toContain("audit-only plugin finding");
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
    expect(message).toContain("state/openclaw.sqlite#exec_approvals_config");
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

  it("warns when model provider API keys are stored as plaintext in config", async () => {
    await noteSecurityWarnings({
      models: {
        providers: {
          openai: {
            apiKey: "sk-openai-plaintext",
          },
        },
      },
    } as unknown as OpenClawConfig);

    const message = lastMessage();
    expect(message).toContain("plaintext secret-bearing config fields");
    expect(message).toContain("models.providers.openai.apiKey");
    expect(message).toContain("openclaw secrets audit --check");
  });

  it("warns when sensitive model provider headers are stored as plaintext in config", async () => {
    await noteSecurityWarnings({
      models: {
        providers: {
          openai: {
            headers: {
              Authorization: "Bearer sk-header-plaintext",
            },
          },
        },
      },
    } as unknown as OpenClawConfig);

    const message = lastMessage();
    expect(message).toContain("plaintext secret-bearing config fields");
    expect(message).toContain("models.providers.openai.headers.Authorization");
  });

  it("does not warn when non-sensitive model provider headers are stored as plaintext in config", async () => {
    await noteSecurityWarnings({
      models: {
        providers: {
          openai: {
            headers: {
              "X-Proxy-Region": "us-west",
            },
          },
        },
      },
    } as unknown as OpenClawConfig);

    const message = lastMessage();
    expect(message).not.toContain("plaintext secret-bearing config fields");
    expect(message).not.toContain("models.providers.openai.headers.X-Proxy-Region");
  });

  it("keeps request headers aligned with secrets audit plaintext checks", async () => {
    await noteSecurityWarnings({
      models: {
        providers: {
          openai: {
            request: {
              headers: {
                "X-Proxy-Region": "us-west",
              },
            },
          },
        },
      },
    } as unknown as OpenClawConfig);

    const message = lastMessage();
    expect(message).toContain("plaintext secret-bearing config fields");
    expect(message).toContain("models.providers.openai.request.headers.X-Proxy-Region");
  });

  it("does not warn when model provider API keys are stored as SecretRefs", async () => {
    await noteSecurityWarnings({
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
      models: {
        providers: {
          openai: {
            apiKey: "${OPENAI_API_KEY}",
          },
        },
      },
    } as unknown as OpenClawConfig);

    const message = lastMessage();
    expect(message).not.toContain("plaintext secret-bearing config fields");
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
              mode: "full",
            },
          },
        } as OpenClawConfig);
      },
    );

    const message = lastMessage();
    expect(message).toContain("tools.exec is broader than the host exec policy");
    expect(message).toContain('tools.exec.mode="full"');
    expect(message).toContain('defaults.security="allowlist"');
    expect(message).toContain("stricter side wins");
  });

  it("warns when normalized tools.exec mode is broader than host exec defaults", async () => {
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
              mode: "full",
            },
          },
        } as OpenClawConfig);
      },
    );

    const message = lastMessage();
    expect(message).toContain("tools.exec is broader than the host exec policy");
    expect(message).toContain('tools.exec.mode="full"');
    expect(message).toContain('defaults.security="allowlist"');
    expect(message).not.toContain("OpenClaw default");
  });

  it("attributes broader host policy warnings to wildcard agent entries", async () => {
    await expectAgentExecHostPolicyWarning("*");
  });

  it("does not invent host policy defaults when exec-approvals defaults are unset", async () => {
    await withExecApprovalsFile(
      {
        version: 1,
        agents: {},
      },
      async () => {
        await noteSecurityWarnings({
          tools: {
            exec: {
              mode: "ask",
            },
          },
        } as OpenClawConfig);
      },
    );

    expect(note).not.toHaveBeenCalled();
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
              mode: "full",
            },
          },
          agents: {
            entries: { runner: {} },
          },
        } as OpenClawConfig);
      },
    );

    const message = lastMessage();
    expect(message).toContain(
      "agents.entries.runner.tools.exec is broader than the host exec policy",
    );
    expect(message).toContain('tools.exec.mode="full"');
    expect(message).toContain('agents.runner.security="allowlist"');
    expect(message).toContain('agents.runner.ask="always"');
  });

  it("fails closed on malformed persisted host policy instead of attributing partial fields", async () => {
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
              mode: "full",
            },
          },
          agents: {
            entries: { runner: {} },
          },
        } as OpenClawConfig);
      },
    );

    const message = lastMessage();
    expect(message).toContain(
      "agents.entries.runner.tools.exec is broader than the host exec policy",
    );
    expect(message).toContain('defaults.security="deny"');
    expect(message).not.toContain('defaults.ask="always"');
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
              mode: "ask",
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
