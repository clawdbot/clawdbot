import { describe, expect, it } from "vitest";
import {
  WORKER_PROTOCOL_FEATURES,
  WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH,
  WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
  WORKER_RPC_SET_VERSION,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { WORKER_INFERENCE_MAX_CONTEXT_MESSAGES } from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import type { WorkerLaunchDescriptor } from "./launch-descriptor.js";
import { buildWorkerConnectParams, parseWorkerLaunchDescriptor } from "./launch-descriptor.js";

function launchDescriptor(): WorkerLaunchDescriptor {
  return {
    version: 3,
    connectionEndpoint: { kind: "unix", socketPath: "/tmp/openclaw-worker/gateway.sock" },
    admission: {
      environmentId: "environment-1",
      credential: ["worker", "fixture", "value"].join("-"),
      sessionId: "session-1",
      ownerEpoch: 3,
      rpcSetVersion: WORKER_RPC_SET_VERSION,
      handshake: {
        bundleHash: "a".repeat(64),
        openclawVersion: "2026.7.12",
        protocolFeatures: [...WORKER_PROTOCOL_FEATURES],
      },
    },
    assignment: {
      agentId: "agent-1",
      operationalRunInstance: { instanceId: "instance-run-1", runId: "run-1" },
      agentRuntimeIdentityToken: "signed-runtime-token",
      runId: "run-1",
      turnId: "turn-1",
      prompt: "Inspect the workspace.",
      suppressPromptTranscript: false,
      workspaceDir: "/tmp/openclaw-worker/workspace",
      modelRef: { provider: "provider-1", model: "model-1" },
      inferenceOptions: { reasoning: "medium", maxTokens: 512 },
      initialMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "Earlier context." }],
          timestamp: 1,
        },
      ],
      transcript: { baseLeafId: "leaf-7", nextSeq: 8 },
      liveEvents: { ackedSeq: 12, nextSeq: 13 },
      toolAuthority: { allowedToolNames: ["read", "exec"] },
    },
  };
}

describe("worker launch descriptor", () => {
  it("accepts the exact admitted single-session launch shape", () => {
    const descriptor = launchDescriptor();

    expect(parseWorkerLaunchDescriptor(structuredClone(descriptor))).toEqual(descriptor);
    expect(buildWorkerConnectParams(descriptor)).toMatchObject({
      role: "worker",
      client: { id: "openclaw-worker", mode: "worker", version: "2026.7.12" },
      admission: { ...descriptor.admission, runId: descriptor.assignment.runId },
    });
  });

  it("accepts only closed Unix or public WebSocket connection endpoints", () => {
    const descriptor = launchDescriptor();
    descriptor.connectionEndpoint = {
      kind: "websocket",
      url: "wss://gateway.example/tenant/__openclaw__/worker",
      tlsFingerprint: "ab:".repeat(31) + "ab",
    };
    expect(parseWorkerLaunchDescriptor(structuredClone(descriptor))).toEqual({
      ...descriptor,
      connectionEndpoint: {
        ...descriptor.connectionEndpoint,
        tlsFingerprint: "ab".repeat(32),
      },
    });

    const invalidEndpoints: unknown[] = [
      { kind: "unix", socketPath: "gateway.sock" },
      { kind: "unix", socketPath: "/tmp/gateway:sock" },
      { kind: "websocket", url: "https://gateway.example/__openclaw__/worker" },
      { kind: "websocket", url: "ws://user@gateway.example/__openclaw__/worker" },
      { kind: "websocket", url: "wss://gateway.example/other" },
      { kind: "websocket", url: "wss://gateway.example/__openclaw__/worker?token=x" },
      {
        kind: "websocket",
        url: "ws://127.0.0.1/__openclaw__/worker",
        tlsFingerprint: "ab".repeat(32),
      },
      {
        kind: "websocket",
        url: "ws://127.0.0.1/__openclaw__/worker",
        cloudflareAccess: {
          clientId: "cf-worker-plaintext-id",
          clientSecret: "cf-worker-plaintext-secret",
        },
      },
      {
        kind: "websocket",
        url: "wss://gateway.example/__openclaw__/worker",
        tlsFingerprint: "",
      },
      {
        kind: "websocket",
        url: "wss://gateway.example/__openclaw__/worker",
        tlsFingerprint: "ab:cd:ef",
      },
      {
        kind: "websocket",
        url: "wss://gateway.example/__openclaw__/worker",
        tlsFingerprint: "g".repeat(64),
      },
      { ...descriptor.connectionEndpoint, unexpected: true },
    ];
    for (const connectionEndpoint of invalidEndpoints) {
      expect(() => parseWorkerLaunchDescriptor({ ...descriptor, connectionEndpoint })).toThrow(
        "invalid worker launch descriptor",
      );
    }
  });

  it("rejects unknown fields at every launch-owned boundary", () => {
    const descriptor = launchDescriptor();
    const cases: unknown[] = [
      { ...descriptor, unexpected: true },
      {
        ...descriptor,
        admission: { ...descriptor.admission, unexpected: true },
      },
      {
        ...descriptor,
        assignment: { ...descriptor.assignment, unexpected: true },
      },
      {
        ...descriptor,
        assignment: {
          ...descriptor.assignment,
          operationalRunInstance: { instanceId: "instance-run-1", runId: "other-run" },
        },
      },
      {
        ...descriptor,
        assignment: {
          ...descriptor.assignment,
          modelRef: { ...descriptor.assignment.modelRef, unexpected: true },
        },
      },
      {
        ...descriptor,
        assignment: {
          ...descriptor.assignment,
          inferenceOptions: { ...descriptor.assignment.inferenceOptions, unexpected: true },
        },
      },
      {
        ...descriptor,
        assignment: {
          ...descriptor.assignment,
          transcript: { ...descriptor.assignment.transcript, unexpected: true },
        },
      },
      {
        ...descriptor,
        assignment: {
          ...descriptor.assignment,
          liveEvents: { ...descriptor.assignment.liveEvents, unexpected: true },
        },
      },
      {
        ...descriptor,
        assignment: {
          ...descriptor.assignment,
          toolAuthority: { ...descriptor.assignment.toolAuthority, unexpected: true },
        },
      },
    ];

    for (const candidate of cases) {
      expect(() => parseWorkerLaunchDescriptor(candidate)).toThrow(
        "invalid worker launch descriptor",
      );
    }
  });

  it("requires a unique closed worker tool authority", () => {
    const descriptor = launchDescriptor();
    const { toolAuthority: _missing, ...assignmentWithoutAuthority } = descriptor.assignment;
    const cases: unknown[] = [
      { ...descriptor, version: 2 },
      { ...descriptor, assignment: assignmentWithoutAuthority },
      {
        ...descriptor,
        assignment: {
          ...descriptor.assignment,
          toolAuthority: { allowedToolNames: ["read", "read"] },
        },
      },
      {
        ...descriptor,
        assignment: {
          ...descriptor.assignment,
          toolAuthority: { allowedToolNames: ["read", "gateway"] },
        },
      },
    ];

    for (const candidate of cases) {
      expect(() => parseWorkerLaunchDescriptor(candidate)).toThrow(
        "invalid worker launch descriptor",
      );
    }

    descriptor.assignment.toolAuthority.allowedToolNames = [];
    expect(parseWorkerLaunchDescriptor(structuredClone(descriptor))).toEqual(descriptor);

    descriptor.assignment.toolAuthority.allowedToolNames = ["browser"];
    expect(parseWorkerLaunchDescriptor(structuredClone(descriptor))).toEqual(descriptor);
  });

  it("accepts only a closed absolute loopback browser attachment descriptor", () => {
    const descriptor = launchDescriptor();
    descriptor.assignment.browser = {
      cdpUrl: "http://127.0.0.1:9222",
      launcherPath: "/usr/local/bin/openclaw-worker-browser",
    };
    expect(parseWorkerLaunchDescriptor(structuredClone(descriptor))).toEqual(descriptor);

    const browser = descriptor.assignment.browser;
    const cases: unknown[] = [
      { ...browser, unexpected: true },
      { ...browser, cdpUrl: "https://127.0.0.1:9222" },
      { ...browser, cdpUrl: "http://localhost:9222" },
      { ...browser, cdpUrl: "http://127.0.0.1" },
      { ...browser, cdpUrl: "http://127.0.0.1:9222/json/version" },
      { ...browser, launcherPath: "openclaw-worker-browser" },
    ];
    for (const invalidBrowser of cases) {
      expect(() =>
        parseWorkerLaunchDescriptor({
          ...descriptor,
          assignment: { ...descriptor.assignment, browser: invalidBrowser },
        }),
      ).toThrow("invalid worker launch descriptor");
    }
  });

  it("rejects the legacy v2 assignment without admitted execution context", () => {
    const descriptor = launchDescriptor();
    const {
      operationalRunInstance: _operationalRunInstance,
      agentRuntimeIdentityToken: _agentRuntimeIdentityToken,
      ...legacyAssignment
    } = descriptor.assignment;

    expect(() =>
      parseWorkerLaunchDescriptor({ ...descriptor, assignment: legacyAssignment }),
    ).toThrow("invalid worker launch descriptor");
  });

  it("requires the host-assigned agent identity", () => {
    const descriptor = launchDescriptor();
    const { agentId: _agentId, ...assignmentWithoutAgent } = descriptor.assignment;

    expect(() =>
      parseWorkerLaunchDescriptor({ ...descriptor, assignment: assignmentWithoutAgent }),
    ).toThrow("invalid worker launch descriptor");
    for (const agentId of ["", " agent-1", "a".repeat(WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH + 1)]) {
      expect(() =>
        parseWorkerLaunchDescriptor({
          ...descriptor,
          assignment: { ...descriptor.assignment, agentId },
        }),
      ).toThrow("invalid worker launch descriptor");
    }
  });

  it("rejects non-absolute paths, unattached sessions, and discontinuous event sequences", () => {
    const descriptor = launchDescriptor();
    const cases: unknown[] = [
      {
        ...descriptor,
        connectionEndpoint: { kind: "unix", socketPath: "gateway.sock" },
      },
      {
        ...descriptor,
        assignment: { ...descriptor.assignment, workspaceDir: "workspace" },
      },
      {
        ...descriptor,
        admission: { ...descriptor.admission, sessionId: null },
      },
      {
        ...descriptor,
        admission: { ...descriptor.admission, ownerEpoch: 0 },
      },
      {
        ...descriptor,
        assignment: {
          ...descriptor.assignment,
          liveEvents: { ackedSeq: 12, nextSeq: 14 },
        },
      },
    ];

    for (const candidate of cases) {
      expect(() => parseWorkerLaunchDescriptor(candidate)).toThrow(
        "invalid worker launch descriptor",
      );
    }
  });

  it("caps initial history at the inference context limit", () => {
    const descriptor = launchDescriptor();
    const message = descriptor.assignment.initialMessages[0];
    if (!message) {
      throw new Error("expected launch fixture message");
    }
    descriptor.assignment.initialMessages = Array.from(
      { length: WORKER_INFERENCE_MAX_CONTEXT_MESSAGES },
      () => structuredClone(message),
    );
    expect(parseWorkerLaunchDescriptor(structuredClone(descriptor))).toEqual(descriptor);

    descriptor.assignment.initialMessages = Array.from(
      { length: WORKER_INFERENCE_MAX_CONTEXT_MESSAGES + 1 },
      () => structuredClone(message),
    );

    expect(() => parseWorkerLaunchDescriptor(descriptor)).toThrow(
      "invalid worker launch descriptor",
    );
  });

  it("rejects a prompt that cannot fit its transcript frame", () => {
    const descriptor = launchDescriptor();
    descriptor.assignment.prompt = "x".repeat(WORKER_PROTOCOL_MAX_PAYLOAD_BYTES);

    expect(() => parseWorkerLaunchDescriptor(descriptor)).toThrow(
      "invalid worker launch descriptor",
    );
  });
});
