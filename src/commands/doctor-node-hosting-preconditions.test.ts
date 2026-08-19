// Doctor node-hosting precondition tests cover browser-only auth and unreachable onboarding.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { collectNodeHostingPreconditionFindings } from "./doctor-node-hosting-preconditions.js";

function findingsFor(cfg: OpenClawConfig) {
  return collectNodeHostingPreconditionFindings(cfg);
}

describe("node-hosting preconditions", () => {
  const healthyBase = {
    gateway: {
      bind: "lan",
      auth: { mode: "token", token: "configured-token" },
    },
    agents: {
      defaults: {
        model: "anthropic/claude-sonnet-4-6",
        models: {
          "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "openclaw" } },
        },
      },
    },
  } satisfies OpenClawConfig;

  it.each([
    {
      name: "identity-header auth alone",
      cfg: {
        ...healthyBase,
        gateway: {
          bind: "lan",
          auth: { mode: "trusted-proxy" },
        },
      },
      requirements: ["machine-client-auth"],
    },
    {
      name: "loopback onboarding alone",
      cfg: {
        ...healthyBase,
        gateway: {
          bind: "loopback",
          auth: { mode: "token", token: "configured-token" },
        },
      },
      requirements: ["node-onboarding-url"],
    },
    {
      name: "both unavailable",
      cfg: {
        ...healthyBase,
        gateway: {
          bind: "loopback",
          auth: { mode: "trusted-proxy" },
        },
      },
      requirements: ["machine-client-auth", "node-onboarding-url"],
    },
    {
      name: "Tailscale identity without a shared secret",
      cfg: {
        ...healthyBase,
        gateway: {
          bind: "loopback",
          tailscale: { mode: "serve" },
          auth: { mode: "token", allowTailscale: true },
        },
      },
      requirements: ["machine-client-auth"],
    },
  ] satisfies Array<{
    name: string;
    cfg: OpenClawConfig;
    requirements: string[];
  }>)("warns when $name", ({ cfg, requirements }) => {
    expect(findingsFor(cfg).map((finding) => finding.requirement)).toEqual(requirements);
  });

  it("does not warn for token auth with a reachable bind", () => {
    expect(findingsFor(healthyBase)).toEqual([]);
  });

  it.each([
    {
      name: "device-pair is explicitly disabled",
      cfg: {
        ...healthyBase,
        plugins: { entries: { "device-pair": { enabled: false } } },
      },
      requirement: "node-onboarding-plugin",
    },
    {
      name: "every configured agent resolves to an external runtime",
      cfg: {
        ...healthyBase,
        agents: {
          ownership: "explicit",
          entries: {
            writer: {
              model: "openai/gpt-5.6-sol",
              models: { "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } } },
            },
            reviewer: {
              model: "anthropic/claude-sonnet-4-6",
              models: { "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "acpx" } } },
            },
          },
        },
      },
      requirement: "device-session-runtime",
    },
  ] satisfies Array<{ name: string; cfg: OpenClawConfig; requirement: string }>)(
    "warns when $name",
    ({ cfg, requirement }) => {
      expect(findingsFor(cfg).map((finding) => finding.requirement)).toContain(requirement);
    },
  );

  it("keeps a mixed explicit roster healthy when one agent uses the embedded runtime", () => {
    expect(
      findingsFor({
        ...healthyBase,
        agents: {
          ownership: "explicit",
          entries: {
            cloud: {
              model: "openai/gpt-5.6-sol",
              models: { "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } } },
            },
            device: {
              model: "anthropic/claude-sonnet-4-6",
              models: {
                "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "openclaw" } },
              },
            },
          },
        },
      }),
    ).toEqual([]);
  });

  it("gives verbatim onboarding and device-runtime remediation", () => {
    const findings = findingsFor({
      ...healthyBase,
      plugins: { entries: { "device-pair": { enabled: false } } },
      agents: {
        defaults: {
          model: "openai/gpt-5.6-sol",
          models: { "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } } },
        },
      },
    });

    expect(
      findings.find((finding) => finding.requirement === "node-onboarding-plugin")?.fixHint,
    ).toBe(
      "Set plugins.entries.device-pair.enabled: true, ensure device-pair is not denied or excluded by plugins.allow, then restart the Gateway.",
    );
    expect(
      findings.find((finding) => finding.requirement === "device-session-runtime")?.fixHint,
    ).toBe(
      'Set agentRuntime.id: "openclaw" on at least one provider/model route (models.providers.<provider>.agentRuntime, agents.defaults.models["provider/model"].agentRuntime, or agents.entries.<id>.models["provider/model"].agentRuntime), then select that agent/model for paired-device sessions. Runtime policy is model/provider-scoped; whole-agent runtime keys are ignored. For a multi-agent roster, set agents.ownership: "explicit".',
    );
  });

  it("gives accurate machine-auth and edge-routing remediation", () => {
    const findings = findingsFor({
      ...healthyBase,
      gateway: {
        bind: "loopback",
        auth: { mode: "trusted-proxy" },
      },
    });

    expect(findings.find((finding) => finding.requirement === "machine-client-auth")?.fixHint).toBe(
      "Switch gateway.auth.mode to token and configure gateway.auth.token as a SecretRef so machine clients can authenticate as devices. Keep trusted-proxy only if machine clients use a clean loopback/direct gateway.auth.password path. For Access-fronted gateways, configure the node gateway.cloudflareAccess.clientId / clientSecret SecretInputs or set CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET before openclaw connect.",
    );
    expect(findings.find((finding) => finding.requirement === "node-onboarding-url")).toMatchObject(
      {
        message:
          "Gateway is only bound to loopback. Set gateway.bind=lan, enable tailscale serve, or configure plugins.entries.device-pair.config.publicUrl.",
        fixHint:
          "If an edge proxy fronts node onboarding, allow /j/* and /__openclaw__/worker without edge identity auth, and preserve WebSocket upgrade on /__openclaw__/worker. Both routes enforce their own credentials.",
      },
    );
  });

  it("accepts a configured public URL for loopback onboarding", () => {
    expect(
      findingsFor({
        ...healthyBase,
        gateway: {
          bind: "loopback",
          auth: { mode: "token", token: "configured-token" },
        },
        plugins: {
          entries: {
            "device-pair": { config: { publicUrl: "wss://gateway.example" } },
          },
        },
      }),
    ).toEqual([]);
  });
});
