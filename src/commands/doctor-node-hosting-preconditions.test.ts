// Doctor node-hosting precondition tests cover browser-only auth and unreachable onboarding.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { collectNodeHostingPreconditionFindings } from "./doctor-node-hosting-preconditions.js";

function findingsFor(cfg: OpenClawConfig) {
  return collectNodeHostingPreconditionFindings(cfg);
}

describe("node-hosting preconditions", () => {
  it.each([
    {
      name: "identity-header auth alone",
      cfg: {
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
    expect(
      findingsFor({
        gateway: {
          bind: "lan",
          auth: {
            mode: "token",
            token: { source: "env", provider: "default", id: "GATEWAY_TOKEN" },
          },
        },
      }),
    ).toEqual([]);
  });

  it("gives accurate machine-auth and edge-routing remediation", () => {
    const findings = findingsFor({
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
