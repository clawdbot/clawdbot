import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SecretInput } from "../config/types.secrets.js";
import { hasActiveGatewayExecCredential } from "./doctor-gateway-exec-credential.js";

const execRef = { source: "exec", provider: "vault", id: "PRIVATE_EDGE_REF_ID" } as const;
type GatewayExecEdgeCredentialCase = {
  label: string;
  mode: "local" | "remote";
  targetUrl?: string;
  edgeAuth: Record<string, SecretInput>;
  expected: boolean;
};

describe("hasActiveGatewayExecCredential", () => {
  it.each<GatewayExecEdgeCredentialCase>([
    {
      label: "the configured remote target uses an exec-backed edge header",
      mode: "remote" as const,
      edgeAuth: { "X-Edge-Auth": execRef },
      expected: true,
    },
    {
      label: "a matching target differs only by query parameters",
      mode: "remote" as const,
      targetUrl: "wss://gateway.example.test/rpc?profile=two",
      edgeAuth: { "X-Edge-Auth": execRef },
      expected: true,
    },
    {
      label: "the effective target is a different gateway",
      mode: "remote" as const,
      targetUrl: "wss://other-gateway.example.test/rpc",
      edgeAuth: { "X-Edge-Auth": execRef },
      expected: false,
    },
    {
      label: "a local gateway cannot use unrelated remote edge headers",
      mode: "local" as const,
      edgeAuth: { "X-Edge-Auth": execRef },
      expected: false,
    },
    {
      label: "matching literal and environment-backed headers do not execute",
      mode: "remote" as const,
      edgeAuth: {
        "X-Literal": "literal-edge-value",
        "X-Environment": { source: "env", provider: "default", id: "EDGE_TOKEN" } as const,
      },
      expected: false,
    },
  ])("detects only effective exec edge credentials when $label", async (entry) => {
    const cfg: OpenClawConfig = {
      gateway: {
        mode: entry.mode,
        remote: { url: "wss://gateway.example.test/rpc", edgeAuth: entry.edgeAuth },
      },
    };

    await expect(
      hasActiveGatewayExecCredential({ cfg, env: {}, targetUrl: entry.targetUrl }),
    ).resolves.toBe(entry.expected);
  });
});
