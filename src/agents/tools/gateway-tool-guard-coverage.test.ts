import { describe, expect, it } from "vitest";
import {
  assertGatewayConfigMutationAllowedForTest,
  PROTECTED_GATEWAY_CONFIG_PATHS_FOR_TEST,
} from "./gateway-tool.js";

function expectBlocked(
  currentConfig: Record<string, unknown>,
  patch: Record<string, unknown>,
): void {
  expect(() =>
    assertGatewayConfigMutationAllowedForTest({
      action: "config.patch",
      currentConfig,
      raw: JSON.stringify(patch),
    }),
  ).toThrow(/cannot (?:change protected|enable dangerous)/);
}

function expectAllowed(
  currentConfig: Record<string, unknown>,
  patch: Record<string, unknown>,
): void {
  expect(() =>
    assertGatewayConfigMutationAllowedForTest({
      action: "config.patch",
      currentConfig,
      raw: JSON.stringify(patch),
    }),
  ).not.toThrow();
}

function expectBlockedApply(
  currentConfig: Record<string, unknown>,
  nextConfig: Record<string, unknown>,
): void {
  expect(() =>
    assertGatewayConfigMutationAllowedForTest({
      action: "config.apply",
      currentConfig,
      raw: JSON.stringify(nextConfig),
    }),
  ).toThrow(/cannot (?:change protected|enable dangerous)/);
}

function expectAllowedApply(
  currentConfig: Record<string, unknown>,
  nextConfig: Record<string, unknown>,
): void {
  expect(() =>
    assertGatewayConfigMutationAllowedForTest({
      action: "config.apply",
      currentConfig,
      raw: JSON.stringify(nextConfig),
    }),
  ).not.toThrow();
}

describe("gateway config mutation guard coverage", () => {
  it("keeps advisory-critical protected path coverage in the production denylist", () => {
    expect(PROTECTED_GATEWAY_CONFIG_PATHS_FOR_TEST).toEqual(
      expect.arrayContaining([
        "agents.defaults.sandbox",
        "agents.list[].sandbox",
        "agents.list[].tools",
        "agents.list[].embeddedPi",
        "tools.fs",
        "plugins.allow",
        "plugins.entries",
        "hooks.token",
        "hooks.allowRequestSessionKey",
        "browser.ssrfPolicy",
        "mcp.servers",
      ]),
    );
  });

  it("blocks disabling sandbox mode via config.patch", () => {
    expectBlocked(
      { agents: { defaults: { sandbox: { mode: "all" } } } },
      { agents: { defaults: { sandbox: { mode: "off" } } } },
    );
  });

  it("blocks enabling an installed-but-disabled plugin via config.patch", () => {
    expectBlocked(
      { plugins: { entries: { malicious: { enabled: false } } } },
      { plugins: { entries: { malicious: { enabled: true } } } },
    );
  });

  it("blocks clearing tools.fs.workspaceOnly hardening via config.patch", () => {
    expectBlocked(
      { tools: { fs: { workspaceOnly: true } } },
      { tools: { fs: { workspaceOnly: false } } },
    );
  });

  it("blocks enabling sandbox dangerouslyAllowContainerNamespaceJoin via config.patch", () => {
    expectBlocked(
      {
        agents: {
          defaults: {
            sandbox: {
              docker: { dangerouslyAllowContainerNamespaceJoin: false },
            },
          },
        },
      },
      {
        agents: {
          defaults: {
            sandbox: {
              docker: { dangerouslyAllowContainerNamespaceJoin: true },
            },
          },
        },
      },
    );
  });

  it("blocks unlocking exec/shell/spawn on /tools/invoke via gateway.tools.allow", () => {
    expectBlocked(
      { gateway: { tools: { allow: [] as string[] } } },
      { gateway: { tools: { allow: ["exec", "shell", "spawn"] } } },
    );
  });

  it("blocks in-place hooks.mappings sessionKey rewrite via mergeObjectArraysById", () => {
    expectBlocked(
      {
        hooks: {
          mappings: [{ id: "gmail", sessionKey: "hook:gmail:{{messages[0].id}}" }],
        },
      },
      {
        hooks: {
          mappings: [{ id: "gmail", sessionKey: "hook:{{payload.session}}" }],
        },
      },
    );
  });

  it("blocks per-agent sandbox override under agents.list[]", () => {
    expectBlocked(
      {
        agents: {
          list: [{ id: "worker", sandbox: { mode: "all" } }],
        },
      },
      {
        agents: {
          list: [{ id: "worker", sandbox: { mode: "off" } }],
        },
      },
    );
  });

  it("blocks id-less per-agent sandbox injection under agents.list[]", () => {
    expectBlocked(
      { agents: { list: [] as Array<Record<string, unknown>> } },
      {
        agents: {
          list: [{ sandbox: { mode: "off" } }],
        },
      },
    );
  });

  it("blocks per-agent tools.allow override under agents.list[]", () => {
    expectBlocked(
      {
        agents: {
          list: [{ id: "worker", tools: { allow: [] as string[] } }],
        },
      },
      {
        agents: {
          list: [{ id: "worker", tools: { allow: ["exec", "shell", "spawn"] } }],
        },
      },
    );
  });

  it("blocks per-agent embeddedPi override under agents.list[]", () => {
    expectBlocked(
      {
        agents: {
          list: [{ id: "worker", embeddedPi: { executionContract: "strict-agentic" } }],
        },
      },
      {
        agents: {
          list: [{ id: "worker", embeddedPi: { executionContract: "none" } }],
        },
      },
    );
  });

  it("blocks subagent tool deny-list override via tools.subagents", () => {
    expectBlocked(
      { tools: { subagents: { tools: { allow: [] as string[] } } } },
      { tools: { subagents: { tools: { allow: ["gateway", "cron", "sessions_send"] } } } },
    );
  });

  it("blocks gateway.auth.token rewrite via config.patch", () => {
    expectBlocked(
      { gateway: { auth: { mode: "token", token: "operator-secret" } } },
      { gateway: { auth: { token: "attacker-known-token" } } },
    );
  });

  it("blocks gateway.tls.certPath redirect via config.patch", () => {
    expectBlocked(
      { gateway: { tls: { enabled: true, certPath: "/etc/openclaw/cert.pem" } } },
      { gateway: { tls: { certPath: "/tmp/attacker/cert.pem" } } },
    );
  });

  it("blocks plugins.load.paths injection via config.patch", () => {
    expectBlocked(
      { plugins: { load: { paths: [] as string[] } } },
      { plugins: { load: { paths: ["/tmp/malicious-plugin"] } } },
    );
  });

  it("blocks plugins.slots memory swap via config.patch", () => {
    expectBlocked(
      { plugins: { slots: { memory: "official-memory" } } },
      { plugins: { slots: { memory: "attacker-memory" } } },
    );
  });

  it("blocks root sandbox override via config.patch", () => {
    expectBlocked({ sandbox: { mode: "all" } }, { sandbox: { mode: "off" } });
  });

  it("blocks plugins.allow edits via config.patch", () => {
    expectBlocked(
      { plugins: { allow: ["trusted-plugin"] } },
      { plugins: { allow: ["trusted-plugin", "evil-plugin"] } },
    );
  });

  it("blocks hooks.token rewrites via config.patch", () => {
    expectBlocked({ hooks: { token: "operator-secret" } }, { hooks: { token: "attacker-secret" } });
  });

  it("blocks hooks.allowRequestSessionKey via config.patch", () => {
    expectBlocked(
      { hooks: { allowRequestSessionKey: false } },
      { hooks: { allowRequestSessionKey: true } },
    );
  });

  it("blocks browser.ssrfPolicy rewrites via config.patch", () => {
    expectBlocked(
      { browser: { ssrfPolicy: { dangerouslyAllowPrivateNetwork: false } } },
      { browser: { ssrfPolicy: { dangerouslyAllowPrivateNetwork: true } } },
    );
  });

  it("blocks mcp.servers rewrites via config.patch", () => {
    expectBlocked(
      { mcp: { servers: {} } },
      { mcp: { servers: { evil: { command: "nc", args: ["-e", "/bin/sh"] } } } },
    );
  });

  it("allows adding a new agent without protected subfields via config.patch", () => {
    expectAllowed(
      {
        agents: {
          list: [{ id: "worker", sandbox: { mode: "all" } }],
        },
      },
      {
        agents: {
          list: [{ id: "helper", model: "sonnet-4.6" }],
        },
      },
    );
  });

  it("allows removing an agent without protected subfields via config.apply", () => {
    expectAllowedApply(
      {
        agents: {
          list: [
            { id: "worker", model: "sonnet-4.6" },
            { id: "helper", sandbox: { mode: "all" } },
          ],
        },
      },
      {
        agents: {
          list: [{ id: "helper", sandbox: { mode: "all" } }],
        },
      },
    );
  });

  it("blocks removing an agent that carries a protected sandbox override via config.apply", () => {
    expectBlockedApply(
      {
        agents: {
          list: [
            { id: "worker", sandbox: { mode: "all" } },
            { id: "helper", model: "sonnet-4.6" },
          ],
        },
      },
      {
        agents: {
          list: [{ id: "helper", model: "sonnet-4.6" }],
        },
      },
    );
  });

  it("allows reordering agents without protected changes via config.apply", () => {
    expectAllowedApply(
      {
        agents: {
          list: [
            { id: "worker", sandbox: { mode: "all" } },
            { id: "helper", sandbox: { mode: "all" } },
          ],
        },
      },
      {
        agents: {
          list: [
            { id: "helper", sandbox: { mode: "all" } },
            { id: "worker", sandbox: { mode: "all" } },
          ],
        },
      },
    );
  });

  it("allows reordering agents when a dangerous per-agent sandbox flag is already enabled", () => {
    expectAllowedApply(
      {
        agents: {
          list: [
            {
              id: "worker",
              sandbox: {
                docker: { dangerouslyAllowContainerNamespaceJoin: true },
              },
            },
            { id: "helper" },
          ],
        },
      },
      {
        agents: {
          list: [
            { id: "helper" },
            {
              id: "worker",
              sandbox: {
                docker: { dangerouslyAllowContainerNamespaceJoin: true },
              },
            },
          ],
        },
      },
    );
  });

  it("blocks adding a new agent with a protected sandbox override via config.patch", () => {
    expectBlocked(
      {
        agents: {
          list: [{ id: "worker", sandbox: { mode: "all" } }],
        },
      },
      {
        agents: {
          list: [{ id: "helper", sandbox: { mode: "off" } }],
        },
      },
    );
  });

  it("still allows benign agent-driven tweaks", () => {
    expectAllowed(
      {
        agents: {
          defaults: { prompt: "You are a helpful assistant." },
          list: [{ id: "worker", model: "sonnet-4" }],
        },
      },
      {
        agents: {
          defaults: { prompt: "You are a terse assistant." },
          list: [{ id: "worker", model: "opus-4.6" }],
        },
      },
    );
  });

  it("blocks config.apply replacing the config with protected changes", () => {
    expectBlockedApply(
      {
        agents: {
          defaults: { sandbox: { mode: "all" }, prompt: "You are a helpful assistant." },
        },
      },
      {
        agents: {
          defaults: { sandbox: { mode: "off" }, prompt: "You are a terse assistant." },
        },
      },
    );
  });

  it("blocks config.apply duplicate-id protected rewrites", () => {
    expectBlockedApply(
      {
        agents: {
          list: [{ id: "worker", sandbox: { mode: "all" } }],
        },
      },
      {
        agents: {
          list: [
            { id: "worker", sandbox: { mode: "off" } },
            { id: "worker", sandbox: { mode: "all" } },
          ],
        },
      },
    );
  });

  it("still allows benign config.apply replacements", () => {
    expectAllowedApply(
      {
        agents: {
          defaults: { prompt: "You are a helpful assistant." },
          list: [{ id: "worker", model: "sonnet-4" }],
        },
      },
      {
        agents: {
          defaults: { prompt: "You are a terse assistant." },
          list: [{ id: "worker", model: "opus-4.6" }],
        },
      },
    );
  });
});
