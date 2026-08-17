/**
 * Tests for environment gateway methods and configured environment discovery.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { listNodePairing } from "../../infra/device-pairing-node.js";
import { listDevicePairing } from "../../infra/device-pairing.js";
import { NODE_RUNNER_UPDATE_REQUIRED_ISSUE } from "../../infra/node-runner-inventory.js";
import { NODE_DESKTOP_STREAM_COMMAND } from "../../shared/node-desktop-stream.js";
import {
  collectNodeRunnerIssuesByNodeId,
  collectNodeWorkerBundleStatusByNodeId,
  isNodeRunnerSessionHost,
} from "../node-registry-private.js";
import type { WorkerEnvironmentServiceRecord } from "../worker-environments/service-contract.js";
import type { WorkerEnvironmentRecord } from "../worker-environments/store.js";
import { environmentsHandlers, summarizeWorkerEnvironment } from "./environments.js";

vi.mock("../../infra/device-pairing.js", () => ({
  listDevicePairing: vi.fn(),
  resolveNodePairingState: vi.fn(),
}));

vi.mock("../../infra/device-pairing-node.js", () => ({
  listNodePairing: vi.fn(),
}));

vi.mock("../node-registry-private.js", () => ({
  collectNodeRunnerIssuesByNodeId: vi.fn(() => new Map()),
  collectNodeWorkerBundleStatusByNodeId: vi.fn(() => new Map()),
  isNodeRunnerSessionHost: vi.fn(() => false),
}));

const NOW = 10_000;

type TestWorkerRecord = WorkerEnvironmentRecord &
  Pick<
    WorkerEnvironmentServiceRecord,
    "desktopAvailable" | "desktopApps" | "tunnelStatus" | "error"
  >;

type TestWorkerService = {
  list: () => TestWorkerRecord[];
  get: (environmentId: string) => TestWorkerRecord | undefined;
  listMachineOptions: (
    profileId: string,
  ) => Promise<
    Array<{ id: string; label: string; description?: string; default?: boolean }> | undefined
  >;
  create: (profileId: string, idempotencyKey: string) => Promise<TestWorkerRecord>;
  destroy: (environmentId: string) => Promise<TestWorkerRecord>;
  destroyUnattached: (environmentId: string) => Promise<TestWorkerRecord>;
  observeDesktop: (request: { environmentId: string; control: boolean }) => Promise<{
    transport: "rfb";
    wsPath: string;
    expiresAtMs: number;
    control: boolean;
    vncPassword?: string;
  }>;
  launchDesktopApp: (request: {
    environmentId: string;
    app: "browser" | "terminal";
  }) => Promise<{ app: "browser" | "terminal"; status: "ready" }>;
};

function mockContext(
  workerEnvironmentService?: TestWorkerService,
  reconcileActive: (environmentId?: string) => Promise<void> = vi.fn(async () => {}),
  forceDestroyEnvironment: (
    environmentId: string,
    onCleanupError?: (error: unknown) => void,
  ) => Promise<TestWorkerRecord> = vi.fn(async () => workerRecord({ state: "destroyed" })),
  connectedNodes: unknown[] = [
    {
      nodeId: "node-live",
      connId: "conn-live",
      displayName: "Live Node",
      platform: "ios",
      caps: ["camera"],
      commands: ["system.run"],
      connectedAtMs: 123,
    },
  ],
) {
  return {
    logGateway: {
      warn: vi.fn(),
    },
    nodeRegistry: {
      listConnectedForPairingStates: () => connectedNodes,
    },
    workerEnvironmentService,
    getRuntimeConfig: () => ({
      cloudWorkers: {
        profiles: {
          zeta: { provider: "static-ssh", settings: {} },
          aws: { provider: "crabbox", settings: {} },
        },
      },
    }),
    ...(workerEnvironmentService
      ? {
          workerPlacementDispatchService: {
            dispatch: vi.fn(),
            forceDestroyEnvironment,
            reconcileActive,
          },
        }
      : {}),
  };
}

function workerRecord(overrides: Partial<TestWorkerRecord> = {}): TestWorkerRecord {
  return {
    environmentId: "worker-1",
    providerId: "static-ssh",
    profileId: "development",
    profileSnapshot: { settings: {} },
    provisionOperationId: "provision:worker-1",
    leaseId: "lease-1",
    sharedHost: false,
    desktop: null,
    sshEndpoint: {
      host: "worker.example.test",
      port: 22,
      user: "openclaw",
      hostKey: ["ssh-ed25519", "AAAA"].join(" "),
      keyRef: { source: "file", provider: "default", id: "/worker/private-key" },
    },
    state: "ready",
    attachedSessionIds: [],
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
    stateChangedAtMs: 1_000,
    idleSinceAtMs: null,
    lastError: null,
    tunnelStatus: "stopped",
    desktopAvailable: false,
    desktopApps: [],
    ...overrides,
  } as TestWorkerRecord;
}

function workerService(overrides: Partial<TestWorkerService> = {}) {
  return {
    list: vi.fn(() => []),
    get: vi.fn(() => undefined),
    listMachineOptions: vi.fn(async () => undefined),
    create: vi.fn(async () => workerRecord()),
    destroy: vi.fn(async () => workerRecord({ state: "destroyed" })),
    destroyUnattached: vi.fn(async () => workerRecord({ state: "destroyed" })),
    observeDesktop: vi.fn(async ({ control }) => ({
      transport: "rfb" as const,
      wsPath: "/desktop/observe?token=abc",
      expiresAtMs: 70_000,
      control,
    })),
    launchDesktopApp: vi.fn(async ({ app }) => ({ app, status: "ready" as const })),
    ...overrides,
  };
}

async function callEnvironmentMethod(
  method:
    | "environments.list"
    | "environments.status"
    | "environments.create"
    | "environments.destroy"
    | "worker.desktop.observe"
    | "worker.desktop.launch",
  params: unknown,
  options: {
    service?: TestWorkerService;
    reconcileActive?: (environmentId?: string) => Promise<void>;
    forceDestroyEnvironment?: (
      environmentId: string,
      onCleanupError?: (error: unknown) => void,
    ) => Promise<TestWorkerRecord>;
    connectedNodes?: unknown[];
  } = {},
) {
  const respond = vi.fn();
  await environmentsHandlers[method]?.({
    params: params as Record<string, unknown>,
    respond,
    context: mockContext(
      options.service,
      options.reconcileActive,
      options.forceDestroyEnvironment,
      options.connectedNodes,
    ),
  } as never);
  const call = respond.mock.calls.at(0);
  if (call === undefined) {
    throw new Error("expected environments handler to respond");
  }
  return call;
}

class FakeWorkerServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  vi.mocked(isNodeRunnerSessionHost).mockReturnValue(false);
  vi.mocked(collectNodeRunnerIssuesByNodeId).mockReturnValue(new Map());
  vi.mocked(collectNodeWorkerBundleStatusByNodeId).mockReturnValue(new Map());
  vi.mocked(listDevicePairing).mockResolvedValue({ paired: [] } as never);
  vi.mocked(listNodePairing).mockResolvedValue({
    paired: [
      {
        nodeId: "node-offline",
        displayName: "Offline Node",
        caps: ["screen"],
        commands: ["camera.snap"],
      },
    ],
  } as never);
});

afterEach(() => vi.restoreAllMocks());

describe("environment gateway methods", () => {
  it("projects live node session-host capability without a worker service", async () => {
    vi.mocked(isNodeRunnerSessionHost).mockImplementation(({ nodeId }) => nodeId === "node-live");
    const [ok, payload] = await callEnvironmentMethod("environments.list", {});

    expect(ok).toBe(true);
    expect(payload).toEqual({
      environments: [
        {
          id: "gateway",
          type: "local",
          label: "Gateway local",
          status: "available",
          platform: process.platform,
          sessionHost: true,
          trust: "persistent",
          capabilities: ["agent.run", "sessions", "tools", "workspace"],
        },
        {
          id: "node:node-live",
          type: "node",
          label: "Live Node",
          status: "available",
          platform: "ios",
          sessionHost: true,
          lastConnectedAtMs: 123,
          lastSeenAtMs: 123,
          lastSeenReason: "connect",
          trust: "persistent",
          capabilities: ["camera", "system.run"],
        },
        {
          id: "node:node-offline",
          type: "node",
          label: "Offline Node",
          status: "unavailable",
          sessionHost: false,
          trust: "persistent",
          capabilities: ["camera.snap", "screen"],
        },
      ],
    });
  });

  it("preserves never-connected and clean-disconnect history for offline nodes", async () => {
    vi.mocked(listNodePairing).mockResolvedValue({
      paired: [
        {
          nodeId: "node-never",
          displayName: "Never Node",
          commands: ["system.run"],
          lastSeenAtMs: 2_000,
          lastSeenReason: "device-token-auth",
        },
        {
          nodeId: "node-lost",
          displayName: "Lost Node",
          commands: ["system.run"],
          lastConnectedAtMs: 1_000,
          lastDisconnectedAtMs: 4_000,
          lastSeenAtMs: 3_000,
          lastSeenReason: "silent_push",
        },
      ],
    } as never);

    const [ok, payload] = await callEnvironmentMethod(
      "environments.list",
      {},
      { connectedNodes: [] },
    );

    expect(ok).toBe(true);
    const environments = (payload as { environments: Array<Record<string, unknown>> }).environments;
    expect(environments.find((entry) => entry.id === "node:node-never")).toMatchObject({
      status: "unavailable",
      lastSeenAtMs: 2_000,
      lastSeenReason: "device-token-auth",
    });
    expect(environments.find((entry) => entry.id === "node:node-never")).not.toHaveProperty(
      "lastConnectedAtMs",
    );
    expect(environments.find((entry) => entry.id === "node:node-lost")).toMatchObject({
      status: "unavailable",
      lastConnectedAtMs: 1_000,
      lastDisconnectedAtMs: 4_000,
      lastSeenAtMs: 3_000,
      lastSeenReason: "silent_push",
    });
  });

  it("projects the same redacted worker bundle status through list and status", async () => {
    vi.mocked(collectNodeWorkerBundleStatusByNodeId).mockReturnValue(
      new Map([["node-live", { status: "installed", version: "2026.8.9" }]]),
    );

    const [, listPayload] = await callEnvironmentMethod("environments.list", {});
    const [, statusPayload] = await callEnvironmentMethod("environments.status", {
      environmentId: "node:node-live",
    });
    const listed = (
      listPayload as { environments: Array<{ id: string; workerBundle?: unknown }> }
    ).environments.find((environment) => environment.id === "node:node-live");

    expect(listed?.workerBundle).toEqual({ status: "installed", version: "2026.8.9" });
    expect(statusPayload).toMatchObject({
      workerBundle: { status: "installed", version: "2026.8.9" },
    });
    expect(JSON.stringify({ listed, statusPayload })).not.toContain("bundleHash");
  });

  it("projects the same current-node update issue through list and status", async () => {
    vi.mocked(collectNodeRunnerIssuesByNodeId).mockReturnValue(
      new Map([["node-live", [NODE_RUNNER_UPDATE_REQUIRED_ISSUE]]]),
    );

    const [, listPayload] = await callEnvironmentMethod("environments.list", {});
    const [, statusPayload] = await callEnvironmentMethod("environments.status", {
      environmentId: "node:node-live",
    });
    const listed = (
      listPayload as { environments: Array<{ id: string; issues?: unknown[] }> }
    ).environments.find((environment) => environment.id === "node:node-live");

    expect(listed?.issues).toEqual([NODE_RUNNER_UPDATE_REQUIRED_ISSUE]);
    expect(statusPayload).toMatchObject({ issues: [NODE_RUNNER_UPDATE_REQUIRED_ISSUE] });
    expect(
      (
        listPayload as { environments: Array<{ id: string; issues?: unknown[] }> }
      ).environments.find((environment) => environment.id === "gateway"),
    ).not.toHaveProperty("issues");
  });

  it("marks only connected, advertised, and explicitly allowed nodes as desktop sources", async () => {
    const context = mockContext();
    context.getRuntimeConfig = () =>
      ({
        gateway: { nodes: { commands: { allow: [NODE_DESKTOP_STREAM_COMMAND] } } },
      }) as never;
    context.nodeRegistry.listConnectedForPairingStates = () =>
      [
        {
          nodeId: "node-desktop",
          connId: "conn-desktop",
          displayName: "Desktop Node",
          platform: "linux",
          deviceFamily: "Linux",
          caps: [],
          commands: [NODE_DESKTOP_STREAM_COMMAND],
          connectedAtMs: 123,
        },
        {
          nodeId: "node-without-command",
          connId: "conn-plain",
          displayName: "Plain Node",
          platform: "linux",
          deviceFamily: "Linux",
          caps: [],
          commands: [],
          connectedAtMs: 123,
        },
      ] as never;
    const respond = vi.fn();
    await environmentsHandlers["environments.list"]?.({
      params: {},
      respond,
      context,
    } as never);
    const environments = respond.mock.calls[0]?.[1].environments as Array<{
      id: string;
      desktop?: boolean;
    }>;
    expect(environments.find((entry) => entry.id === "node:node-desktop")?.desktop).toBe(true);
    expect(
      environments.find((entry) => entry.id === "node:node-without-command")?.desktop,
    ).toBeUndefined();
    expect(environments.find((entry) => entry.id === "node:node-offline")?.desktop).toBeUndefined();
  });

  it("appends worker metadata with stable sessions and elapsed times", async () => {
    const service = workerService({
      list: vi.fn(() => [
        workerRecord({
          state: "idle",
          attachedSessionIds: ["session-z", "session-a", "session-z", " "],
          idleSinceAtMs: 6_000,
        }),
      ]),
    });
    const [ok, payload] = await callEnvironmentMethod("environments.list", {}, { service });

    expect(ok).toBe(true);
    expect(payload).toMatchObject({
      profiles: [
        { id: "aws", providerId: "crabbox" },
        { id: "zeta", providerId: "static-ssh" },
      ],
      environments: [
        { id: "gateway", type: "local" },
        { id: "node:node-live", type: "node" },
        { id: "node:node-offline", type: "node" },
        {
          id: "worker-1",
          type: "worker",
          status: "available",
          trust: "disposable",
          worker: {
            providerId: "static-ssh",
            leaseId: "lease-1",
            state: "idle",
            ageMs: 9_000,
            idleMs: 4_000,
            attachedSessionIds: ["session-a", "session-z"],
            tunnelStatus: "stopped",
          },
        },
      ],
    });
    const worker = (payload as { environments: Array<Record<string, unknown>> }).environments.at(
      -1,
    );
    expect(worker).not.toHaveProperty("sshEndpoint");
    expect(worker?.worker).not.toHaveProperty("sshEndpoint");
    expect(worker?.worker).not.toHaveProperty("keyRef");
  });

  it("adds provider machine options to configured profile summaries", async () => {
    const listMachineOptions = vi.fn(async (profileId: string) =>
      profileId === "aws"
        ? [
            {
              id: "standard",
              label: "Standard",
              description: "Cheap smoke checks and small repos",
              default: true,
            },
          ]
        : undefined,
    );
    const [ok, payload] = await callEnvironmentMethod(
      "environments.list",
      {},
      { service: workerService({ listMachineOptions }) },
    );

    expect(ok).toBe(true);
    expect(payload).toMatchObject({
      profiles: [
        {
          id: "aws",
          providerId: "crabbox",
          machines: [
            {
              id: "standard",
              label: "Standard",
              description: "Cheap smoke checks and small repos",
              default: true,
            },
          ],
        },
        { id: "zeta", providerId: "static-ssh" },
      ],
    });
    expect(listMachineOptions.mock.calls).toEqual([["aws"], ["zeta"]]);
  });

  it.each([
    ["requested", "starting"],
    ["ready", "available"],
    ["draining", "stopping"],
    ["destroyed", "unavailable"],
    ["failed", "error"],
    ["orphaned", "error"],
  ] as const)("maps worker state %s to %s", (state, status) => {
    expect(summarizeWorkerEnvironment(workerRecord({ state }), NOW).status).toBe(status);
  });

  it("projects trust from recorded worker isolation without guessing unknown leases", () => {
    expect(summarizeWorkerEnvironment(workerRecord({ sharedHost: true }), NOW).trust).toBe(
      "persistent",
    );
    expect(summarizeWorkerEnvironment(workerRecord({ sharedHost: false }), NOW).trust).toBe(
      "disposable",
    );
    expect(summarizeWorkerEnvironment(workerRecord({ sharedHost: null }), NOW)).not.toHaveProperty(
      "trust",
    );
  });

  it("projects recorded errors only for terminal error states", () => {
    expect(
      summarizeWorkerEnvironment(
        workerRecord({ state: "failed", error: "provider teardown failed" }),
        NOW,
      ).worker,
    ).toMatchObject({ error: "provider teardown failed" });
    expect(
      summarizeWorkerEnvironment(
        workerRecord({ state: "ready", error: "stale transient error" }),
        NOW,
      ).worker,
    ).not.toHaveProperty("error");
  });

  it("projects desktop metadata only when the service reports it available", () => {
    expect(
      summarizeWorkerEnvironment(
        workerRecord({ desktopAvailable: true, desktopApps: ["browser", "terminal"] }),
        NOW,
      ).worker,
    ).toMatchObject({ desktop: true, desktopApps: ["browser", "terminal"] });
    expect(
      summarizeWorkerEnvironment(workerRecord({ desktopAvailable: false, desktopApps: [] }), NOW)
        .worker,
    ).not.toHaveProperty("desktopApps");
  });

  it("returns status for one node environment", async () => {
    vi.mocked(isNodeRunnerSessionHost).mockReturnValue(true);
    const [ok, payload] = await callEnvironmentMethod("environments.status", {
      environmentId: "node:node-live",
    });

    expect(ok).toBe(true);
    expect(payload).toEqual({
      id: "node:node-live",
      type: "node",
      label: "Live Node",
      status: "available",
      platform: "ios",
      sessionHost: true,
      lastConnectedAtMs: 123,
      lastSeenAtMs: 123,
      lastSeenReason: "connect",
      trust: "persistent",
      capabilities: ["camera", "system.run"],
    });
  });

  it("returns status for one worker without listing providers", async () => {
    const get = vi.fn(() => workerRecord({ state: "attached" }));
    const service = workerService({ get });
    const [ok, payload] = await callEnvironmentMethod(
      "environments.status",
      { environmentId: "worker-1" },
      { service },
    );

    expect(ok).toBe(true);
    expect(payload).toMatchObject({
      id: "worker-1",
      status: "available",
      trust: "disposable",
      worker: { state: "attached", ageMs: 9_000 },
    });
    expect(get).toHaveBeenCalledWith("worker-1");
    expect(service.list).not.toHaveBeenCalled();
  });

  it("rejects unknown environment ids", async () => {
    const [ok, , error] = await callEnvironmentMethod("environments.status", {
      environmentId: "missing",
    });

    expect(ok).toBe(false);
    expect(error).toEqual({
      code: ErrorCodes.INVALID_REQUEST,
      message: "unknown environmentId",
    });
  });

  it("preserves gateway listing and hides durable-store details when worker reads fail", async () => {
    const secret = "private SecretRef and database path";
    const listFailure = workerService({
      list: vi.fn(() => {
        throw new Error(secret);
      }),
    });
    const statusFailure = workerService({
      get: vi.fn(() => {
        throw new Error(secret);
      }),
    });

    const listResult = await callEnvironmentMethod(
      "environments.list",
      {},
      {
        service: listFailure,
      },
    );
    const statusResult = await callEnvironmentMethod(
      "environments.status",
      { environmentId: "worker-missing" },
      { service: statusFailure },
    );

    expect(listResult[0]).toBe(true);
    const listed = (listResult[1] as { environments: Array<{ id: string; type: string }> })
      .environments;
    // Gateway/node inventory survives a damaged worker store; worker rows are omitted.
    expect(listed.map((entry) => entry.id)).toEqual([
      "gateway",
      "node:node-live",
      "node:node-offline",
    ]);
    expect(listed.every((entry) => entry.type !== "worker")).toBe(true);
    expect(statusResult[2]).toEqual({
      code: ErrorCodes.UNAVAILABLE,
      message: "environment status unavailable",
    });
    expect(JSON.stringify([listResult, statusResult])).not.toContain(secret);
  });

  it("keeps worker creation unavailable until a provider profile is configured", async () => {
    const [ok, , error] = await callEnvironmentMethod("environments.create", {
      profileId: "development",
      idempotencyKey: "request-1",
    });

    expect(ok).toBe(false);
    expect(error).toEqual({
      code: ErrorCodes.INVALID_REQUEST,
      message: "cloud worker environments are not configured",
    });
  });

  it("creates a worker from a configured profile", async () => {
    const create = vi.fn(async () => workerRecord());
    const service = workerService({ create });
    const [ok, payload] = await callEnvironmentMethod(
      "environments.create",
      { profileId: "development", idempotencyKey: "request-1" },
      { service },
    );

    expect(ok).toBe(true);
    expect(create).toHaveBeenCalledWith("development", "request-1");
    expect(payload).toMatchObject({
      id: "worker-1",
      type: "worker",
      worker: { providerId: "static-ssh", state: "ready" },
    });
  });

  it("rejects an unknown worker profile", async () => {
    const service = workerService({
      create: vi.fn(async () => {
        throw new FakeWorkerServiceError("profile_not_found", "unknown worker profile: missing");
      }),
    });
    const [ok, , error] = await callEnvironmentMethod(
      "environments.create",
      { profileId: "missing", idempotencyKey: "request-1" },
      { service },
    );

    expect(ok).toBe(false);
    expect(error).toEqual({
      code: ErrorCodes.INVALID_REQUEST,
      message: "unknown worker profile: missing",
    });
  });

  it("hides provider failure details when worker creation fails", async () => {
    const service = workerService({
      create: vi.fn(async () => {
        throw new FakeWorkerServiceError("provider_failure", "private endpoint details");
      }),
    });
    const [ok, , error] = await callEnvironmentMethod(
      "environments.create",
      { profileId: "development", idempotencyKey: "request-1" },
      { service },
    );

    expect(ok).toBe(false);
    expect(error).toEqual({
      code: ErrorCodes.UNAVAILABLE,
      message: "worker environment creation failed",
    });
  });

  it("starts desktop observation with explicit and default control modes", async () => {
    const observeDesktop = vi.fn(async ({ control }: { control: boolean }) => ({
      transport: "rfb" as const,
      wsPath: "/desktop/observe?token=abc",
      expiresAtMs: 70_000,
      control,
    }));
    const service = workerService({ observeDesktop });
    const first = await callEnvironmentMethod(
      "worker.desktop.observe",
      { environmentId: "worker-1", control: true },
      { service },
    );
    const second = await callEnvironmentMethod(
      "worker.desktop.observe",
      { environmentId: "worker-1" },
      { service },
    );
    expect(first).toEqual([
      true,
      {
        transport: "rfb",
        wsPath: "/desktop/observe?token=abc",
        expiresAtMs: 70_000,
        control: true,
      },
      undefined,
    ]);
    expect(second[1]).toMatchObject({ control: false });
    expect(observeDesktop).toHaveBeenNthCalledWith(1, {
      environmentId: "worker-1",
      control: true,
    });
    expect(observeDesktop).toHaveBeenNthCalledWith(2, {
      environmentId: "worker-1",
      control: false,
    });
  });

  it("maps desktop lifecycle errors to invalid request and hides runtime failures", async () => {
    const invalidService = workerService({
      observeDesktop: vi.fn(async () => {
        throw new FakeWorkerServiceError("invalid_state", "environment has no desktop");
      }),
    });
    const unavailableService = workerService({
      observeDesktop: vi.fn(async () => {
        throw new FakeWorkerServiceError("provider_failure", "private SSH failure");
      }),
    });
    expect(
      await callEnvironmentMethod(
        "worker.desktop.observe",
        { environmentId: "worker-1" },
        { service: invalidService },
      ),
    ).toEqual([
      false,
      undefined,
      { code: ErrorCodes.INVALID_REQUEST, message: "environment has no desktop" },
    ]);
    expect(
      await callEnvironmentMethod(
        "worker.desktop.observe",
        { environmentId: "worker-1" },
        { service: unavailableService },
      ),
    ).toEqual([
      false,
      undefined,
      { code: ErrorCodes.UNAVAILABLE, message: "worker desktop observe unavailable" },
    ]);
  });

  it("launches only a closed advertised desktop app and returns readiness", async () => {
    const launchDesktopApp = vi.fn(async ({ app }: { app: "browser" | "terminal" }) => ({
      app,
      status: "ready" as const,
    }));
    const service = workerService({ launchDesktopApp });
    const result = await callEnvironmentMethod(
      "worker.desktop.launch",
      { environmentId: "worker-1", app: "browser" },
      { service },
    );

    expect(result).toEqual([true, { app: "browser", status: "ready" }, undefined]);
    expect(launchDesktopApp).toHaveBeenCalledExactlyOnceWith({
      environmentId: "worker-1",
      app: "browser",
    });
    const rejected = await callEnvironmentMethod(
      "worker.desktop.launch",
      { environmentId: "worker-1", app: "editor" },
      { service },
    );
    expect(rejected[0]).toBe(false);
    expect(launchDesktopApp).toHaveBeenCalledOnce();
  });

  it("maps typed desktop launcher errors without exposing unknown runtime details", async () => {
    const cases = [
      [
        "desktop_app_not_found",
        ErrorCodes.INVALID_REQUEST,
        "environment does not advertise desktop app: browser",
      ],
      [
        "unsupported_platform",
        ErrorCodes.INVALID_REQUEST,
        "desktop app launch is not supported on Windows gateway hosts",
      ],
      [
        "launcher_failure",
        ErrorCodes.UNAVAILABLE,
        "worker desktop browser launcher failed; verify the app is installed and retry",
      ],
      [
        "provider_failure",
        ErrorCodes.UNAVAILABLE,
        "worker desktop app launch unavailable; try again",
      ],
    ] as const;
    for (const [serviceCode, gatewayCode, message] of cases) {
      const service = workerService({
        launchDesktopApp: vi.fn(async () => {
          throw new FakeWorkerServiceError(
            serviceCode,
            serviceCode === "provider_failure" ? "private SSH detail" : message,
          );
        }),
      });
      const response = await callEnvironmentMethod(
        "worker.desktop.launch",
        { environmentId: "worker-1", app: "browser" },
        { service },
      );
      expect(response[2]).toEqual({ code: gatewayCode, message });
    }
  });

  it("destroys an environment idempotently", async () => {
    const destroyed = workerRecord({ state: "destroyed" });
    const destroyUnattached = vi.fn(async () => destroyed);
    const service = workerService({ destroyUnattached });
    const first = await callEnvironmentMethod(
      "environments.destroy",
      { environmentId: "worker-1" },
      { service },
    );
    const second = await callEnvironmentMethod(
      "environments.destroy",
      { environmentId: "worker-1" },
      { service },
    );

    expect(first).toEqual(second);
    expect(first[0]).toBe(true);
    expect(first[1]).toMatchObject({
      id: "worker-1",
      status: "unavailable",
      worker: { state: "destroyed" },
    });
    expect(destroyUnattached).toHaveBeenCalledTimes(2);
  });

  it("rejects raw destruction of a session-attached worker", async () => {
    const service = workerService({
      destroyUnattached: vi.fn(async () => {
        throw new FakeWorkerServiceError(
          "invalid_state",
          "Attached cloud workers must be stopped through sessions.reclaim",
        );
      }),
    });

    const [ok, , error] = await callEnvironmentMethod(
      "environments.destroy",
      { environmentId: "worker-1" },
      { service },
    );

    expect(ok).toBe(false);
    expect(error).toEqual({
      code: ErrorCodes.INVALID_REQUEST,
      message: "Attached cloud workers must be stopped through sessions.reclaim",
    });
  });

  it("durably abandons placement ownership before forced destruction", async () => {
    const service = workerService();
    const forceDestroyEnvironment = vi.fn(async () => workerRecord({ state: "destroyed" }));

    const [ok, payload] = await callEnvironmentMethod(
      "environments.destroy",
      { environmentId: "worker-1", force: true },
      { service, forceDestroyEnvironment },
    );

    expect(ok).toBe(true);
    expect(payload).toMatchObject({ worker: { state: "destroyed" } });
    expect(forceDestroyEnvironment).toHaveBeenCalledExactlyOnceWith(
      "worker-1",
      expect.any(Function),
    );
    expect(service.destroy).not.toHaveBeenCalled();
    expect(service.destroyUnattached).not.toHaveBeenCalled();
  });

  it("logs best-effort forced teardown errors without failing the call", async () => {
    const service = workerService();
    const forceDestroyEnvironment = vi.fn(
      async (_environmentId: string, onCleanupError?: (error: unknown) => void) => {
        onCleanupError?.(new Error("provider stop remains pending"));
        return workerRecord({ state: "destroying" });
      },
    );
    const context = mockContext(
      service,
      vi.fn(async () => {}),
      forceDestroyEnvironment,
    );
    const respond = vi.fn();

    await environmentsHandlers["environments.destroy"]?.({
      params: { environmentId: "worker-1", force: true },
      respond,
      context,
    } as never);

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ worker: expect.objectContaining({ state: "destroying" }) }),
      undefined,
    );
    expect(context.logGateway.warn).toHaveBeenCalledWith(
      "worker environment forced teardown cleanup failed: Error: provider stop remains pending",
    );
  });

  it("reconciles active placements before returning destroyed worker state", async () => {
    const service = workerService();
    const reconcileActive = vi.fn(async () => {});

    const [ok, payload] = await callEnvironmentMethod(
      "environments.destroy",
      { environmentId: "worker-1" },
      { service, reconcileActive },
    );

    expect(ok).toBe(true);
    expect(payload).toMatchObject({ worker: { state: "destroyed" } });
    expect(reconcileActive).toHaveBeenCalledExactlyOnceWith("worker-1");
    expect(service.destroyUnattached).toHaveBeenCalledBefore(reconcileActive);
  });

  it("preserves destroyed worker success when placement reconciliation fails", async () => {
    const service = workerService();
    const reconcileActive = vi.fn(async () => {
      throw new Error("temporary reconciliation failure");
    });

    const [ok, payload] = await callEnvironmentMethod(
      "environments.destroy",
      { environmentId: "worker-1" },
      { service, reconcileActive },
    );

    expect(ok).toBe(true);
    expect(payload).toMatchObject({ worker: { state: "destroyed" } });
    expect(reconcileActive).toHaveBeenCalledExactlyOnceWith("worker-1");
  });

  it("rejects an unknown worker environment on destroy", async () => {
    const service = workerService({
      destroyUnattached: vi.fn(async () => {
        throw new FakeWorkerServiceError("environment_not_found", "unknown environmentId");
      }),
    });
    const [ok, , error] = await callEnvironmentMethod(
      "environments.destroy",
      { environmentId: "missing" },
      { service },
    );

    expect(ok).toBe(false);
    expect(error).toEqual({
      code: ErrorCodes.INVALID_REQUEST,
      message: "unknown environmentId",
    });
  });

  it("returns unavailable without provider details when destroy fails", async () => {
    const service = workerService({
      destroyUnattached: vi.fn(async () => {
        throw new FakeWorkerServiceError("provider_not_found", "private provider details");
      }),
    });
    const [ok, , error] = await callEnvironmentMethod(
      "environments.destroy",
      { environmentId: "worker-1" },
      { service },
    );

    expect(ok).toBe(false);
    expect(error).toEqual({
      code: ErrorCodes.UNAVAILABLE,
      message: "worker environment destruction failed",
    });
  });
});
