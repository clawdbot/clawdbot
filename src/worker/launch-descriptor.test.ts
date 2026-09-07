import { describe, expect, it } from "vitest";
import {
  WORKER_PROTOCOL_FEATURES,
  WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH,
  WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
  WORKER_RPC_SET_VERSION,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { WORKER_INFERENCE_MAX_CONTEXT_MESSAGES } from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import { WORKER_PROTOCOL_MAX_MEDIA_PAYLOAD_BYTES } from "../../packages/gateway-protocol/src/schema/worker-protocol-primitives.js";
import { createNoisyPngBuffer } from "../../test/helpers/image-fixtures.js";
import type { WorkerGitHubLaunchBinding, WorkerLaunchDescriptor } from "./launch-descriptor.js";
import { buildWorkerConnectParams, parseWorkerLaunchDescriptor } from "./launch-descriptor.js";

function launchDescriptor(): WorkerLaunchDescriptor {
  return {
    version: 4,
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
      permissionMode: "workspace",
      workerContainmentRoot: "/tmp/openclaw-worker/workspace",
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
  it("admits bounded image-only input and replay without raising the text budget", () => {
    const descriptor = launchDescriptor();
    const image = {
      type: "image" as const,
      data: createNoisyPngBuffer(256, 256).toString("base64"),
      mimeType: "image/png",
    };
    expect(image.data.length).toBeGreaterThan(WORKER_PROTOCOL_MAX_PAYLOAD_BYTES);
    descriptor.assignment.prompt = [image];
    descriptor.assignment.initialMessages = [{ role: "user", content: [image], timestamp: 1 }];
    for (const suppressPromptTranscript of [false, true]) {
      descriptor.assignment.suppressPromptTranscript = suppressPromptTranscript;
      expect(parseWorkerLaunchDescriptor(descriptor)).toEqual(descriptor);
    }
    for (const invalidImage of [
      { ...image, data: "" },
      { ...image, type: "text" },
      { ...image, extra: true },
    ]) {
      expect(() =>
        parseWorkerLaunchDescriptor({
          ...descriptor,
          assignment: { ...descriptor.assignment, prompt: [invalidImage] },
        }),
      ).toThrow("invalid worker launch descriptor");
    }
    descriptor.assignment.prompt = [
      { type: "text", text: "x".repeat(WORKER_PROTOCOL_MAX_PAYLOAD_BYTES) },
      image,
    ];
    expect(() => parseWorkerLaunchDescriptor(descriptor)).toThrow(
      "invalid worker launch descriptor",
    );
    descriptor.assignment.prompt = [
      { ...image, data: "x".repeat(WORKER_PROTOCOL_MAX_MEDIA_PAYLOAD_BYTES) },
    ];
    expect(() => parseWorkerLaunchDescriptor(descriptor)).toThrow(
      "invalid worker launch descriptor",
    );
  });
  it("accepts the exact admitted single-session launch shape", () => {
    const descriptor = launchDescriptor();

    expect(parseWorkerLaunchDescriptor(structuredClone(descriptor))).toEqual(descriptor);
    expect(buildWorkerConnectParams(descriptor)).toMatchObject({
      role: "worker",
      client: { id: "openclaw-worker", mode: "worker", version: "2026.7.12" },
      admission: { ...descriptor.admission, runId: descriptor.assignment.runId },
    });
  });

  it("round-trips turn-bound GitHub identity without adding it to worker admission", () => {
    const descriptor = launchDescriptor();
    const identity = {
      token: "worker-github-token",
      login: "worker-bot",
      branch: "session/worker-1",
    };
    for (const github of [
      identity,
      {
        ...identity,
        remoteUrl: "https://github.com/openclaw/openclaw.git",
        gitAuthor: { name: "Worker Bot", email: "worker@example.test" },
      },
    ]) {
      descriptor.assignment.github = github;
      const parsed = parseWorkerLaunchDescriptor(structuredClone(descriptor));
      expect(parsed.assignment.github).toEqual(github);
      expect(buildWorkerConnectParams(parsed)).not.toHaveProperty("github");
      expect(JSON.stringify(buildWorkerConnectParams(parsed))).not.toContain(github.token);
    }
  });

  it("rejects malformed or open GitHub launch bindings", () => {
    const descriptor = launchDescriptor();
    const github: WorkerGitHubLaunchBinding = {
      token: "worker-github-token",
      login: "worker-bot",
      branch: "session/worker-1",
    };
    const withBinding = (overrides: Record<string, unknown>) =>
      Object.assign({}, github, overrides);
    const invalidBindings: unknown[] = [
      null,
      withBinding({ unexpected: true }),
      { login: github.login, branch: github.branch },
      { token: github.token, branch: github.branch },
      { token: github.token, login: github.login },
      ...["", "token with space", "token\n", "token\u0001", "x".repeat(2049)].map((token) =>
        withBinding({ token }),
      ),
      ...["", "worker_bot", "worker.bot", "worker\n", "x".repeat(40)].map((login) =>
        withBinding({ login }),
      ),
      ...[
        "",
        "-branch",
        "branch with space",
        "branch\u0000",
        "x".repeat(257),
        ...["..", "~", "^", ":", "?", "*", "[", "\\", "@{"].map((part) => `branch${part}name`),
      ].map((branch) => withBinding({ branch })),
      ...[
        "http://github.com/openclaw/openclaw.git",
        "https://example.com/openclaw/openclaw.git",
        "git@github.com:openclaw/openclaw.git",
        "https://github.com/openclaw/openclaw.git?token=x",
        "https://github.com/openclaw/openclaw.git\n",
      ].map((remoteUrl) => withBinding({ remoteUrl })),
      withBinding({ gitAuthor: { unexpected: true } }),
      ...["name", "email"].flatMap((key) =>
        ["", " ", "author\nvalue", "author\rvalue", "author\u0000value", "x".repeat(257)].map(
          (value) => withBinding({ gitAuthor: { [key]: value } }),
        ),
      ),
      Object.assign(Object.create({ token: github.token }), {
        login: github.login,
        branch: github.branch,
      }),
      { ...github, gitAuthor: Object.create({ email: "inherited@example.test" }) },
    ];
    for (const binding of invalidBindings) {
      expect(() =>
        parseWorkerLaunchDescriptor({
          ...descriptor,
          assignment: { ...descriptor.assignment, github: binding },
        }),
      ).toThrow("invalid worker launch descriptor");
    }
  });

  it("rejects a launch version inherited from the prototype", () => {
    const descriptor = launchDescriptor();
    const { version, ...ownFields } = descriptor;
    const candidate = Object.assign(
      Object.create({ version }) as Record<string, unknown>,
      ownFields,
    );

    expect(() => parseWorkerLaunchDescriptor(candidate)).toThrow(
      "invalid worker launch descriptor",
    );
  });

  it("accepts the permission context pair only when both fields are present", () => {
    const descriptor = launchDescriptor();
    const {
      permissionMode: _permissionMode,
      workerContainmentRoot: _root,
      ...withoutContext
    } = descriptor.assignment;
    expect(
      parseWorkerLaunchDescriptor({ ...descriptor, assignment: withoutContext }).assignment,
    ).toEqual(withoutContext);

    for (const assignment of [
      { ...withoutContext, permissionMode: "workspace" },
      { ...withoutContext, workerContainmentRoot: "/tmp/openclaw-worker/workspace" },
    ]) {
      expect(() => parseWorkerLaunchDescriptor({ ...descriptor, assignment })).toThrow(
        "invalid worker launch descriptor",
      );
    }
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
      { ...descriptor, version: 3 },
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

  it("requires a computer descriptor and grant together and rejects target substitution fields", () => {
    const descriptor = launchDescriptor();
    descriptor.assignment.computer = {
      nodeId: "worker-desktop",
      computerUse: {
        contractVersion: 2,
        provider: { id: "fixture", label: "Fixture", generation: "generation-1" },
        actions: ["screenshot"],
        targets: ["screen"],
        deliveryModes: ["foreground"],
        observations: ["image"],
        features: { recording: false, agentCursor: false, multiDisplay: false },
      },
    };
    expect(() => parseWorkerLaunchDescriptor(descriptor)).toThrow(
      "invalid worker launch descriptor",
    );
    descriptor.assignment.toolAuthority.allowedToolNames = ["computer"];
    descriptor.assignment.prompt = [{ type: "image", data: "AA==", mimeType: "image/png" }];
    expect(parseWorkerLaunchDescriptor(descriptor)).toEqual(descriptor);
    const { computer, ...assignmentFields } = descriptor.assignment;
    const inheritedComputerAssignment = Object.assign(
      Object.create({ computer }),
      assignmentFields,
    );
    expect(() =>
      parseWorkerLaunchDescriptor({
        ...descriptor,
        assignment: inheritedComputerAssignment,
      }),
    ).toThrow("invalid worker launch descriptor");
    const { nodeId, ...computerFields } = descriptor.assignment.computer;
    const inheritedNodeIdComputer = Object.assign(Object.create({ nodeId }), computerFields);
    for (const candidateComputer of [
      undefined,
      { ...descriptor.assignment.computer, gatewayUrl: "ws://other" },
      { ...descriptor.assignment.computer, nodeId: "" },
      inheritedNodeIdComputer,
    ]) {
      expect(() =>
        parseWorkerLaunchDescriptor({
          ...descriptor,
          assignment: { ...descriptor.assignment, computer: candidateComputer },
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
        assignment: { ...descriptor.assignment, workerContainmentRoot: "workspace" },
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
