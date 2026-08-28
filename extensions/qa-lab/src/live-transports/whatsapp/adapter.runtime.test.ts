import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expectDefined } from "@openclaw/normalization-core";
import type {
  WhatsAppQaDriverObservedMessage,
  WhatsAppQaDriverSession,
} from "@openclaw/whatsapp/api.js";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { runExec } from "openclaw/plugin-sdk/process-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQaBusState } from "../../bus-state.js";
import { createQaTransportAdapter } from "../../qa-transport-registry.js";
import { runQaFlowSuiteCleanupPlan } from "../../suite.js";
import { createTempDirHarness } from "../../temp-dir.test-helper.js";
import { whatsappQaCliRegistration } from "./cli.js";
import type { WhatsAppQaRuntimeEnv } from "./whatsapp-live.contracts.js";

const mocks = vi.hoisted(() => ({
  acquireLease: vi.fn(),
  heartbeat: vi.fn<() => Promise<void>>(),
  heartbeatStop: vi.fn<() => Promise<void>>(),
  release: vi.fn<() => Promise<void>>(),
  startDriver: vi.fn<({ authDir }: { authDir: string }) => Promise<WhatsAppQaDriverSession>>(),
  closeDriver: vi.fn<() => Promise<void>>(),
}));

vi.mock("../shared/credential-lease.runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/credential-lease.runtime.js")>();
  return {
    ...actual,
    acquireQaCredentialLease: mocks.acquireLease,
    startQaCredentialLeaseHeartbeat(
      lease: Parameters<typeof actual.startQaCredentialLeaseHeartbeat>[0],
    ) {
      const heartbeat = actual.startQaCredentialLeaseHeartbeat(lease);
      return {
        ...heartbeat,
        async stop() {
          await heartbeat.stop();
          await mocks.heartbeatStop();
        },
      };
    },
  };
});

vi.mock("./whatsapp-live.driver.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./whatsapp-live.driver.js")>()),
  startWhatsAppQaDriverSessionWithRetry: mocks.startDriver,
}));

vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>();
  return { ...actual, runExec: vi.fn(actual.runExec) };
});

const execFileAsync = promisify(execFile);
const tempDirs = createTempDirHarness();
const fakeAuth = '{"fixture":"not-a-whatsapp-session"}\n';
let fixtureRoot: string;
let authRoot: string | undefined;
let credentialPayload: WhatsAppQaRuntimeEnv;
let created: Awaited<ReturnType<typeof createQaTransportAdapter>> | undefined;
let observed: WhatsAppQaDriverObservedMessage[];

async function createAdapter() {
  created = await createQaTransportAdapter(
    {
      channelId: "whatsapp",
      driver: "live",
      outputDir: fixtureRoot,
      state: createQaBusState(),
    },
    [expectDefined(whatsappQaCliRegistration.adapterFactory, "WhatsApp adapter factory")],
  );
  return created;
}

async function expectResourcesRetained(sutAuthDir: string) {
  expect.soft(mocks.release, "shared credential must remain leased").not.toHaveBeenCalled();
  expect.soft(mocks.heartbeatStop, "lease heartbeat must remain active").not.toHaveBeenCalled();
  for (const dir of [sutAuthDir, path.join(expectDefined(authRoot, "auth root"), "driver-auth")]) {
    await expect.soft(fs.readFile(path.join(dir, "creds.json"), "utf8")).resolves.toBe(fakeAuth);
  }
}

beforeEach(async () => {
  vi.resetAllMocks();
  authRoot = undefined;
  created = undefined;
  observed = [];
  fixtureRoot = await fs.realpath(await tempDirs.makeTempDir("whatsapp-qa-cleanup-"));
  await fs.writeFile(path.join(fixtureRoot, "creds.json"), fakeAuth);
  const archive = path.join(fixtureRoot, "auth.tgz");
  await execFileAsync("tar", ["-czf", archive, "-C", fixtureRoot, "creds.json"]);
  const archiveBase64 = await fs.readFile(archive, "base64");
  credentialPayload = {
    driverPhoneE164: "+15550000001",
    sutPhoneE164: "+15550000002",
    driverAuthArchiveBase64: archiveBase64,
    sutAuthArchiveBase64: archiveBase64,
  };
  mocks.acquireLease.mockResolvedValue({
    kind: "whatsapp",
    source: "convex",
    heartbeatIntervalMs: 100,
    heartbeat: mocks.heartbeat,
    release: mocks.release,
    payload: credentialPayload,
  });
  mocks.startDriver.mockImplementation(async ({ authDir }) => {
    authRoot = await fs.realpath(path.dirname(authDir));
    return {
      close: mocks.closeDriver,
      getObservedMessages: () => observed,
      sendContact: async () => ({}),
      sendLocation: async () => ({}),
      sendMedia: async () => ({}),
      sendPoll: async () => ({}),
      sendReaction: async () => ({}),
      sendSticker: async () => ({}),
      sendText: async () => ({}),
      waitForMessage: async () => {
        throw new Error("unexpected driver message wait");
      },
    };
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(async () => {
  try {
    if (created) {
      const cleanup = created.cleanupWithoutGateway();
      await vi.advanceTimersByTimeAsync(500);
      await cleanup;
    }
  } finally {
    vi.restoreAllMocks();
    vi.clearAllTimers();
    vi.useRealTimers();
    if (authRoot) {
      await fs.rm(authRoot, { recursive: true, force: true });
    }
    await tempDirs.cleanup();
  }
});

describe("WhatsApp QA adapter cleanup through the suite", () => {
  it.each([
    "none",
    "gateway stop",
    "driver close",
    "heartbeat request",
    "heartbeat stop",
    "lease release",
  ] as const)(
    "keeps lease and auth until terminal Gateway teardown (failure: %s)",
    async (failureAt) => {
      const transport = await createAdapter();
      const cfg = transport.adapter.createGatewayConfig({ baseUrl: "http://127.0.0.1:1" });
      const sutAuthDir = await fs.realpath(
        expectDefined(cfg.channels?.whatsapp?.accounts?.sut?.authDir, "SUT auth directory"),
      );
      await expectResourcesRetained(sutAuthDir);
      if (failureAt === "heartbeat request") {
        mocks.heartbeat.mockRejectedValueOnce(new Error("heartbeat request failed"));
      }
      const lastReply: WhatsAppQaDriverObservedMessage = {
        kind: "text",
        fromPhoneE164: "+15550000002",
        observedAt: new Date().toISOString(),
        text: "last reply before cleanup",
      };
      observed.push(lastReply);
      await vi.advanceTimersByTimeAsync(500);
      expect(transport.adapter.state.getSnapshot().messages.map(({ text }) => text)).toEqual([
        "last reply before cleanup",
      ]);
      if (failureAt === "heartbeat request") {
        await expect(transport.adapter.waitForCondition(() => true)).rejects.toThrow(
          'Credential lease heartbeat failed for kind "whatsapp": heartbeat request failed',
        );
      }

      const failure = new Error(`${failureAt} failed`);
      if (failureAt === "driver close") {
        mocks.closeDriver.mockRejectedValueOnce(failure);
      } else if (failureAt === "heartbeat stop") {
        mocks.heartbeatStop.mockRejectedValueOnce(failure);
      } else if (failureAt === "lease release") {
        mocks.release.mockRejectedValueOnce(failure);
      }
      const gatewayStopped = createDeferred<void>();
      const stopStarted = createDeferred<void>();
      const stopGateway = vi.fn(async () => {
        stopStarted.resolve();
        await gatewayStopped.promise;
        if (failureAt === "gateway stop") {
          throw failure;
        }
      });
      const cleanup = runQaFlowSuiteCleanupPlan({
        cleanupTransportBeforeGatewayStop: transport.cleanupBeforeGatewayStop,
        cleanupTransportAfterGatewayStop: transport.cleanupAfterGatewayStop,
        stopGateway,
        disposeAgentHarnesses: async () => {},
        finishLab: async () => {},
      });
      try {
        // The active polling sleep must drain before the driver or Gateway closes.
        await vi.advanceTimersByTimeAsync(499);
        expect(mocks.closeDriver).not.toHaveBeenCalled();
        expect(stopGateway).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await stopStarted.promise;
        expect(mocks.closeDriver).toHaveBeenCalledOnce();
        await expectResourcesRetained(sutAuthDir);
        mocks.heartbeat.mockClear();
        observed.push({ ...lastReply, text: "must not poll after cleanup" });
        await vi.advanceTimersByTimeAsync(1_000);
        if (failureAt !== "heartbeat request") {
          expect
            .soft(mocks.heartbeat, "heartbeat continues while Gateway stop is pending")
            .toHaveBeenCalled();
        }
        expect(transport.adapter.state.getSnapshot().messages).toHaveLength(1);
      } finally {
        gatewayStopped.resolve();
        await cleanup;
      }
      const failures = await cleanup;
      const phase =
        failureAt === "gateway stop"
          ? "gateway stop"
          : failureAt === "driver close"
            ? "transport before gateway stop"
            : "transport after gateway stop";
      expect(failures).toEqual(
        failureAt === "none" || failureAt === "heartbeat request"
          ? []
          : [{ phase, error: failure }],
      );
      if (failureAt === "gateway stop") {
        await expectResourcesRetained(sutAuthDir);
        mocks.heartbeat.mockClear();
        await vi.advanceTimersByTimeAsync(100);
        expect
          .soft(mocks.heartbeat, "failed Gateway stop must retain heartbeat")
          .toHaveBeenCalled();
      } else {
        expect(mocks.heartbeatStop).toHaveBeenCalledOnce();
        expect(mocks.release).toHaveBeenCalledOnce();
        await expect(fs.stat(expectDefined(authRoot, "auth root"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        mocks.heartbeat.mockClear();
        await vi.advanceTimersByTimeAsync(100);
        expect(mocks.heartbeat).not.toHaveBeenCalled();
      }
    },
  );

  it("stops the heartbeat and releases the lease when the auth root cannot be created", async () => {
    vi.spyOn(fs, "mkdtemp").mockRejectedValueOnce(new Error("auth root creation failed"));

    await expect(createAdapter()).rejects.toThrow("auth root creation failed");

    expect(mocks.startDriver).not.toHaveBeenCalled();
    expect(runExec).not.toHaveBeenCalled();
    expect(mocks.heartbeatStop).toHaveBeenCalledOnce();
    expect(mocks.release).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.heartbeat).not.toHaveBeenCalled();
  });

  it("does not leave a pending auth unpack able to recreate the root after rollback", async () => {
    credentialPayload.driverAuthArchiveBase64 = Buffer.from("not a tar archive").toString("base64");
    const mkdir = fs.mkdir.bind(fs);
    const resumeSutMkdir = createDeferred<void>();
    const driverUnpackFailed = createDeferred<void>();
    const sutExtracted = createDeferred<void>();
    let pendingSutUnpack: Promise<void> | undefined;
    vi.spyOn(fs, "mkdir").mockImplementation(async (dir, options) => {
      if (path.basename(String(dir)) === "sut-auth") {
        pendingSutUnpack = sutExtracted.promise;
        await resumeSutMkdir.promise;
      }
      return await mkdir(dir, options);
    });
    const realRunExec = expectDefined(vi.mocked(runExec).getMockImplementation(), "real exec");
    vi.mocked(runExec).mockImplementation(async (command, args, options) => {
      const archive = args[1];
      if (command === "tar" && archive && path.basename(archive) === "driver-auth.tgz") {
        authRoot = await fs.realpath(path.dirname(archive));
      }
      try {
        return await realRunExec(command, args, options);
      } finally {
        if (archive && path.basename(archive) === "driver-auth.tgz") {
          driverUnpackFailed.resolve();
        }
        if (args[0] === "-xzf" && archive && path.basename(archive) === "sut-auth.tgz") {
          sutExtracted.resolve();
        }
      }
    });

    const initialization = expect(createAdapter()).rejects.toThrow(/tar/);
    try {
      await driverUnpackFailed.promise;
      await vi.advanceTimersByTimeAsync(0);
      // Either avoid starting the second unpack or drain it before releasing resources.
      if (pendingSutUnpack) {
        expect
          .soft(mocks.release, "rollback must retain the lease while auth staging is pending")
          .not.toHaveBeenCalled();
      }
    } finally {
      // If rollback already started, finish it before allowing the delayed writer to resume.
      if (mocks.release.mock.calls.length > 0) {
        await initialization;
      }
      resumeSutMkdir.resolve();
      await pendingSutUnpack;
      await initialization;
    }
    expect(mocks.startDriver).not.toHaveBeenCalled();
    expect(mocks.heartbeatStop).toHaveBeenCalledOnce();
    expect(mocks.release).toHaveBeenCalledOnce();
    await expect(fs.stat(expectDefined(authRoot, "auth root"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each(["none", "heartbeat stop", "lease release"] as const)(
    "immediately removes auth and releases the lease after initialization fails (cleanup failure: %s)",
    async (failureAt) => {
      mocks.startDriver.mockImplementation(async ({ authDir }) => {
        authRoot = await fs.realpath(path.dirname(authDir));
        await expectResourcesRetained(path.join(authRoot, "sut-auth"));
        throw new Error("driver initialization failed");
      });
      if (failureAt === "heartbeat stop") {
        mocks.heartbeatStop.mockRejectedValueOnce(new Error("heartbeat stop failed"));
      } else if (failureAt === "lease release") {
        mocks.release.mockRejectedValueOnce(new Error("lease release failed"));
      }
      await expect(createAdapter()).rejects.toThrow(
        failureAt === "none" ? "driver initialization failed" : `${failureAt} failed`,
      );
      expect(mocks.heartbeatStop).toHaveBeenCalledOnce();
      expect(mocks.release).toHaveBeenCalledOnce();
      await expect(fs.stat(expectDefined(authRoot, "auth root"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      mocks.heartbeat.mockClear();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(mocks.heartbeat).not.toHaveBeenCalled();
    },
  );
});
