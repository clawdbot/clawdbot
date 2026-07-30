import { describe, expect, it } from "vitest";
import {
  HostRuntimeEnvelopeValidationError,
  type HostRuntimeEnvelope,
} from "./host-runtime-envelope.js";
import {
  buildCodexMcpThreadConfig,
  buildDispatcherRouteDecision,
  CodexMcpOwnershipConfigError,
} from "./mcp-thread-config.js";

function createHostRuntimeEnvelope(): HostRuntimeEnvelope {
  return {
    kind: "host-runtime-envelope",
    version: 1,
    owner: "external-host",
    hostId: "geeclaw",
    requestId: "request-123",
    auditId: "audit-geeclaw-telegram",
    endpoint: {
      channel: "telegram",
      accountId: "telegram:bot:geeclaw",
      endpointId: "telegram:geeclaw",
      externalIdentity: "@geeclaw",
    },
    conversation: {
      sessionKey: "telegram:geeclaw:user-42",
      threadOwner: "external-host",
    },
    provider: {
      modelRef: "codex:gpt-5.4",
      routingPolicyId: "gee-provider-default",
    },
    auth: {
      credentialRef: "gee://credentials/openai/work",
      eligibility: "ok",
    },
    tools: {
      capabilityPlanId: "gee-tools-default",
      allowedToolIds: ["message.send"],
      policy: "host-authorized",
    },
    delivery: {
      policyId: "gee-native-outbox",
      outboundTarget: "telegram:chat:42",
    },
    compaction: {
      owner: "external-host",
    },
  };
}

describe("buildCodexMcpThreadConfig", () => {
  it("projects OpenClaw mcp.servers into Codex mcp_servers", () => {
    const result = buildCodexMcpThreadConfig({
      mcp: {
        servers: {
          "gee-code": {
            command: "gee-code-mcp",
            args: [],
            env: { GEE_MODE: "geeclaw" },
            cwd: "/tmp/gee",
          },
        },
      },
    });

    expect(result.evaluated).toBe(true);
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.configPatch).toEqual({
      mcp_servers: {
        "gee-code": {
          args: [],
          command: "gee-code-mcp",
          cwd: "/tmp/gee",
          env: { GEE_MODE: "geeclaw" },
        },
      },
    });
  });

  it("maps remote transports and header environment placeholders", () => {
    const result = buildCodexMcpThreadConfig({
      mcp: {
        servers: {
          remote: {
            url: "https://example.com/mcp",
            transport: "streamable-http",
            headers: {
              Authorization: "Bearer ${OPENCLAW_REMOTE_TOKEN}",
              "X-Trace": "${OPENCLAW_TRACE_ID}",
              "X-Static": "static-value",
            },
          },
        },
      },
    });

    expect(result.configPatch).toEqual({
      mcp_servers: {
        remote: {
          bearer_token_env_var: "OPENCLAW_REMOTE_TOKEN",
          env_http_headers: { "X-Trace": "OPENCLAW_TRACE_ID" },
          http_headers: { "X-Static": "static-value" },
          type: "http",
          url: "https://example.com/mcp",
        },
      },
    });
  });

  it("omits unsupported server entries without forcing legacy threads to rotate", () => {
    const result = buildCodexMcpThreadConfig({
      mcp: {
        servers: {
          invalid: { args: ["--no-command"] },
        },
      },
    });

    expect(result.configPatch).toBeUndefined();
    expect(result.fingerprint).toBeUndefined();
  });

  it("records Host-owned endpoint decisions before starting a thread", () => {
    const result = buildCodexMcpThreadConfig({
      mcp: {
        servers: {
          openclaw: {
            url: "http://127.0.0.1:8811/mcp",
            openclawOwnership: {
              endpointId: "telegram:geeclaw",
              endpointOwner: { kind: "external-host", hostId: "geeclaw" },
              auditId: "audit-geeclaw-telegram",
            },
            openclawRuntimeEnvelope: createHostRuntimeEnvelope(),
          },
        },
      },
    });

    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.ownershipDecisions).toEqual({
      "telegram:geeclaw": {
        owner: "external-host",
        reason: "endpoint-owner",
        endpointId: "telegram:geeclaw",
        threadOwnerId: "geeclaw",
        hostId: "geeclaw",
        auditId: "audit-geeclaw-telegram",
      },
    });
    expect(result.hostRuntimePreparedFacts).toMatchObject({
      "telegram:geeclaw": {
        hostMode: "external-hosted",
        envelope: {
          owner: "external-host",
          endpoint: { endpointId: "telegram:geeclaw" },
          auth: { credentialRef: "gee://credentials/openai/work" },
        },
      },
    });
    expect(result.configPatch).not.toHaveProperty("openclaw_host_runtime");
  });

  it("fails closed when a Host-owned endpoint is missing prepared runtime facts", () => {
    expect(() =>
      buildCodexMcpThreadConfig({
        mcp: {
          servers: {
            openclaw: {
              url: "http://127.0.0.1:8811/mcp",
              openclawOwnership: {
                endpointId: "telegram:geeclaw",
                endpointOwner: { kind: "external-host", hostId: "geeclaw" },
                auditId: "audit-geeclaw-telegram",
              },
            },
          },
        },
      }),
    ).toThrow(HostRuntimeEnvelopeValidationError);
  });

  it("records dispatcher decisions with an explicit runtime-envelope owner", () => {
    const result = buildCodexMcpThreadConfig({
      mcp: {
        servers: {
          openclaw: {
            url: "http://localhost:8822/mcp",
            openclawOwnership: {
              endpointId: "slack:shared",
              endpointOwner: { kind: "dispatcher", dispatcherId: "slack-dispatcher" },
              runtimeEnvelopeOwner: "openclaw",
              auditId: "audit-shared-slack",
              sharedEndpoint: true,
            },
          },
        },
      },
    });

    expect(result.ownershipDecisions).toEqual({
      "slack:shared": {
        owner: "openclaw",
        reason: "dispatcher-decision",
        endpointId: "slack:shared",
        dispatcherId: "slack-dispatcher",
        auditId: "audit-shared-slack",
      },
    });
  });

  it("builds dispatcher route decisions that invoke exactly the decided runtime", () => {
    const route = buildDispatcherRouteDecision({
      intake: {
        endpointId: "slack:shared",
        eventKind: "message",
        payload: { text: "hello" },
        idempotencyKey: "slack:evt:1",
      },
      decision: {
        owner: "external-host",
        reason: "dispatcher-decision",
        endpointId: "slack:shared",
        dispatcherId: "slack-dispatcher",
        auditId: "audit-shared-slack",
      },
      persistedRouteKey: "dispatcher-route:slack:evt:1",
    });

    expect(route).toEqual({
      intake: {
        endpointId: "slack:shared",
        eventKind: "message",
        payload: { text: "hello" },
        idempotencyKey: "slack:evt:1",
      },
      decision: {
        owner: "external-host",
        reason: "dispatcher-decision",
        endpointId: "slack:shared",
        dispatcherId: "slack-dispatcher",
        auditId: "audit-shared-slack",
      },
      persistedRouteKey: "dispatcher-route:slack:evt:1",
      invokedRuntime: "external-host",
    });
  });

  it("fails closed when a dispatcher route drifts from the ownership decision", () => {
    expect(() =>
      buildDispatcherRouteDecision({
        intake: {
          endpointId: "slack:shared",
          eventKind: "message",
          payload: { text: "hello" },
          idempotencyKey: "slack:evt:1",
        },
        decision: {
          owner: "external-host",
          reason: "dispatcher-decision",
          endpointId: "slack:shared",
          dispatcherId: "slack-dispatcher",
          auditId: "audit-shared-slack",
        },
        persistedRouteKey: "dispatcher-route:slack:evt:1",
        invokedRuntime: "openclaw",
      }),
    ).toThrow(CodexMcpOwnershipConfigError);
  });

  it("keeps explicitly configured standalone endpoints on the OpenClaw envelope", () => {
    const result = buildCodexMcpThreadConfig({
      mcp: {
        servers: {
          openclaw: {
            command: "openclaw-mcp",
            openclawOwnership: {
              endpointId: "local-acp",
            },
          },
        },
      },
    });

    expect(result.ownershipDecisions).toEqual({
      "local-acp": {
        owner: "openclaw",
        reason: "standalone-default",
        endpointId: "local-acp",
        auditId: "mcp:local-acp",
      },
    });
    expect(result.hostRuntimePreparedFacts).toBeUndefined();
    expect(result.configPatch).not.toHaveProperty("openclaw_host_runtime");
  });

  it("fails closed when a shared endpoint has no owner decision", () => {
    expect(() =>
      buildCodexMcpThreadConfig({
        mcp: {
          servers: {
            openclaw: {
              url: "http://127.0.0.1:8811/mcp",
              openclawOwnership: {
                endpointId: "telegram:shared",
                sharedEndpoint: true,
              },
            },
          },
        },
      }),
    ).toThrow(CodexMcpOwnershipConfigError);
  });

  it("fails closed when duplicate endpoint configs disagree on ownership", () => {
    expect(() =>
      buildCodexMcpThreadConfig({
        mcp: {
          servers: {
            primary: {
              url: "http://127.0.0.1:8811/mcp",
              openclawOwnership: {
                endpointId: "telegram:shared",
                endpointOwner: { kind: "external-host", hostId: "geeclaw" },
              },
            },
            secondary: {
              url: "http://127.0.0.1:8812/mcp",
              openclawOwnership: {
                endpointId: "telegram:shared",
                endpointOwner: "openclaw",
              },
            },
          },
        },
      }),
    ).toThrow(CodexMcpOwnershipConfigError);
  });
});
