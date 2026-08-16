import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createExecutionIdentityAdmissionToken } from "../audit/execution-identity-admission.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  resetAgentRunRegistryForTest,
  rotateAgentRunRegistryLifecycleGeneration,
} from "../infra/agent-run-registry.js";
import { readExecApprovalsSnapshot } from "../infra/exec-approvals-store.js";
import { testing as execApprovalsStoreTesting } from "../infra/exec-approvals-store.test-support.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";

const envSnapshot = captureEnv(["HOME", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR"]);

const tempHomes: string[] = [];

function operationalRun(runId = "run-1") {
  const operationalRunInstance = { instanceId: `instance-${runId}`, runId } as const;
  const delegatedAuthority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  return { operationalRunInstance, delegatedAuthority };
}

function useTempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-runtime-"));
  tempHomes.push(home);
  setTestEnvValue("HOME", home);
  setTestEnvValue("OPENCLAW_HOME", home);
  setTestEnvValue("OPENCLAW_STATE_DIR", path.join(home, ".openclaw"));
  closeOpenClawStateDatabaseForTest();
  execApprovalsStoreTesting.reset();
  return home;
}

function readExecApprovals(): {
  socket?: { token?: string };
} {
  return readExecApprovalsSnapshot().file;
}

async function importRuntimeTokenModule(): Promise<
  typeof import("./agent-runtime-identity-token.js")
> {
  vi.resetModules();
  return await import("./agent-runtime-identity-token.js");
}

function validateDelegatedAuthority(
  runtimeToken: typeof import("./agent-runtime-identity-token.js"),
  authority: import("./agent-runtime-identity-token.js").AgentRuntimeDelegatedAuthority,
): boolean {
  return runtimeToken.createAgentRuntimeApprovalAuthorityValidator()({
    kind: "agentRuntime",
    agentId: "test",
    sessionKey: "agent:test:test",
    operationalRunInstance: authority.operationalRunInstance,
    delegatedAuthority: authority,
  });
}

afterEach(() => {
  resetAgentRunRegistryForTest();
  closeOpenClawStateDatabaseForTest();
  execApprovalsStoreTesting.reset();
  vi.resetModules();
  envSnapshot.restore();
  for (const home of tempHomes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

describe("agent runtime identity token", () => {
  it("rejects copied delegated authority after terminal, replacement, and restart boundaries", async () => {
    useTempHome();
    const runtimeToken = await importRuntimeTokenModule();
    const first = operationalRun("run-lifecycle");
    const firstRun = first.operationalRunInstance;
    const token = await runtimeToken.mintAgentRuntimeIdentityToken({
      agentId: "main",
      sessionKey: "session-1",
      operationalRunInstance: firstRun,
    });
    const copied = await runtimeToken.verifyAgentRuntimeIdentityToken(token);
    expect(copied).toBeDefined();
    expect(copied && validateDelegatedAuthority(runtimeToken, copied.delegatedAuthority)).toBe(
      true,
    );

    releaseAgentRunDelegatedAuthority(first.delegatedAuthority);
    expect(copied && validateDelegatedAuthority(runtimeToken, copied.delegatedAuthority)).toBe(
      false,
    );

    const replacement = { instanceId: "instance-replacement", runId: firstRun.runId };
    claimAgentRunDelegatedAuthority(replacement);
    expect(copied && validateDelegatedAuthority(runtimeToken, copied.delegatedAuthority)).toBe(
      false,
    );

    const replacementToken = await runtimeToken.mintAgentRuntimeIdentityToken({
      agentId: "main",
      sessionKey: "session-1",
      operationalRunInstance: replacement,
    });
    const replacementIdentity =
      await runtimeToken.verifyAgentRuntimeIdentityToken(replacementToken);
    expect(
      replacementIdentity &&
        validateDelegatedAuthority(runtimeToken, replacementIdentity.delegatedAuthority),
    ).toBe(true);

    rotateAgentRunRegistryLifecycleGeneration();
    expect(
      replacementIdentity &&
        validateDelegatedAuthority(runtimeToken, replacementIdentity.delegatedAuthority),
    ).toBe(false);
  });

  it("persists the local signing secret so tokens verify across processes", async () => {
    useTempHome();
    const firstProcess = await importRuntimeTokenModule();

    const token = await firstProcess.mintAgentRuntimeIdentityToken({
      agentId: "main",
      sessionKey: "session-1",
      ...operationalRun(),
    });

    const persistedToken = readExecApprovals().socket?.token;
    expect(persistedToken).toEqual(expect.any(String));
    expect(persistedToken).not.toHaveLength(0);

    const secondProcess = await importRuntimeTokenModule();
    await expect(secondProcess.verifyAgentRuntimeIdentityToken(token)).resolves.toMatchObject({
      kind: "agentRuntime",
      agentId: "main",
      sessionKey: "session-1",
      operationalRunInstance: operationalRun().operationalRunInstance,
    });
  });

  it("round-trips the authenticated plugin owner and turn-source route", async () => {
    useTempHome();
    const runtimeToken = await importRuntimeTokenModule();
    const token = await runtimeToken.mintAgentRuntimeIdentityToken({
      agentId: "main",
      sessionKey: "session-1",
      ...operationalRun(),
      approvalOwnerPluginId: " codex ",
      turnSourceChannel: " telegram ",
      turnSourceTo: " chat-1 ",
      turnSourceAccountId: " Work ",
      turnSourceThreadId: " thread-1 ",
    });

    await expect(runtimeToken.verifyAgentRuntimeIdentityToken(token)).resolves.toMatchObject({
      kind: "agentRuntime",
      agentId: "main",
      sessionKey: "session-1",
      operationalRunInstance: operationalRun().operationalRunInstance,
      approvalOwnerPluginId: "codex",
      turnSourceChannel: "telegram",
      turnSourceTo: "chat-1",
      turnSourceAccountId: "work",
      turnSourceThreadId: "thread-1",
    });
  });

  it("round-trips explicit local turn provenance without inferring it from the session key", async () => {
    useTempHome();
    const runtimeToken = await importRuntimeTokenModule();
    const run = operationalRun();
    const token = await runtimeToken.mintAgentRuntimeIdentityToken({
      agentId: "main",
      sessionKey: "agent:main:main",
      operationalRunInstance: run.operationalRunInstance,
      turnSourceLocal: true,
    });

    await expect(runtimeToken.verifyAgentRuntimeIdentityToken(token)).resolves.toMatchObject({
      sessionKey: "agent:main:main",
      turnSourceLocal: true,
    });
    await expect(
      runtimeToken.mintAgentRuntimeIdentityToken({
        agentId: "main",
        sessionKey: "agent:main:main",
        operationalRunInstance: run.operationalRunInstance,
        turnSourceChannel: "discord",
        turnSourceLocal: true,
      }),
    ).rejects.toThrow("cannot be both local and channel-bound");
  });

  it("omits execution identity from a different operational run", async () => {
    useTempHome();
    const runtimeToken = await importRuntimeTokenModule();
    const token = await runtimeToken.mintAgentRuntimeIdentityToken({
      agentId: "main",
      sessionKey: "session-1",
      ...operationalRun("run-1"),
      executionIdentityToken: createExecutionIdentityAdmissionToken("run-other"),
    });

    await expect(runtimeToken.verifyAgentRuntimeIdentityToken(token)).resolves.toMatchObject({
      kind: "agentRuntime",
      agentId: "main",
      sessionKey: "session-1",
      operationalRunInstance: operationalRun("run-1").operationalRunInstance,
    });
  });

  it("round-trips a signed visible-session spawn policy", async () => {
    useTempHome();
    const runtimeToken = await importRuntimeTokenModule();
    const token = await runtimeToken.mintAgentRuntimeIdentityToken({
      agentId: "main",
      sessionKey: "agent:main:main",
      ...operationalRun(),
      sessionSpawnContext: {
        completionOwnerSessionKey: " agent:main:discord:direct:alice ",
        inheritedToolPolicy: {
          version: 1,
          allow: [" read ", "sessions_spawn"],
          deny: ["exec"],
        },
      },
    });

    await expect(runtimeToken.verifyAgentRuntimeIdentityToken(token)).resolves.toMatchObject({
      kind: "agentRuntime",
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionSpawnContext: {
        completionOwnerSessionKey: "agent:main:discord:direct:alice",
        inheritedToolPolicy: {
          version: 1,
          allow: ["read", "sessions_spawn"],
          deny: ["exec"],
        },
      },
    });
  });

  it("round-trips a short-lived cron self-management capability", async () => {
    useTempHome();
    const runtimeToken = await importRuntimeTokenModule();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1000);
    const token = await runtimeToken.mintAgentRuntimeIdentityToken({
      agentId: "ops",
      sessionKey: "agent:ops:cron:job-1:run:run-1",
      ...operationalRun(),
      cronSelfManagementJobId: " job-1 ",
    });

    await expect(
      runtimeToken.verifyAgentRuntimeIdentityToken(token, 60_999),
    ).resolves.toMatchObject({
      kind: "agentRuntime",
      agentId: "ops",
      sessionKey: "agent:ops:cron:job-1:run:run-1",
      operationalRunInstance: operationalRun().operationalRunInstance,
      cronSelfManagementContext: { jobId: "job-1", expiresAtMs: 61_000 },
    });
    await expect(
      runtimeToken.verifyAgentRuntimeIdentityToken(token, 61_000),
    ).resolves.toBeUndefined();
    nowSpy.mockRestore();
  });

  it("round-trips final cron-cap capture provenance", async () => {
    useTempHome();
    const runtimeToken = await importRuntimeTokenModule();
    const run = operationalRun();
    const token = await runtimeToken.mintAgentRuntimeIdentityToken({
      agentId: "main",
      sessionKey: "agent:main:main",
      operationalRunInstance: run.operationalRunInstance,
      cronToolsAllowCapture: "final-executable-surface",
    });

    await expect(runtimeToken.verifyAgentRuntimeIdentityToken(token)).resolves.toMatchObject({
      kind: "agentRuntime",
      agentId: "main",
      sessionKey: "agent:main:main",
      operationalRunInstance: run.operationalRunInstance,
      cronToolsAllowCapture: "final-executable-surface",
    });
  });

  it("round-trips a signed private cron creator grant only with final provenance", async () => {
    useTempHome();
    const runtimeToken = await importRuntimeTokenModule();
    const run = operationalRun();
    const cronCreatorAuthorityGrant = { runId: "run-1", token: "opaque-grant" };
    const token = await runtimeToken.mintAgentRuntimeIdentityToken({
      agentId: "main",
      sessionKey: "agent:main:main",
      operationalRunInstance: run.operationalRunInstance,
      cronToolsAllowCapture: "final-executable-surface",
      cronCreatorAuthorityGrant,
    });

    await expect(runtimeToken.verifyAgentRuntimeIdentityToken(token)).resolves.toMatchObject({
      cronToolsAllowCapture: "final-executable-surface",
      cronCreatorAuthorityGrant,
    });
    await expect(
      runtimeToken.mintAgentRuntimeIdentityToken({
        agentId: "main",
        sessionKey: "agent:main:main",
        operationalRunInstance: run.operationalRunInstance,
        cronCreatorAuthorityGrant,
      }),
    ).rejects.toThrow("require final tool-surface provenance");
  });

  it("does not mint local credentials while rejecting invalid presented tokens", async () => {
    useTempHome();
    const runtimeToken = await importRuntimeTokenModule();

    await expect(
      runtimeToken.verifyAgentRuntimeIdentityToken("not-a-valid-token"),
    ).resolves.toBeUndefined();
    expect(readExecApprovalsSnapshot().exists).toBe(false);
  });

  it("rejects a token with a shortened signature", async () => {
    useTempHome();
    const runtimeToken = await importRuntimeTokenModule();
    const token = await runtimeToken.mintAgentRuntimeIdentityToken({
      agentId: "main",
      sessionKey: "session-1",
      ...operationalRun(),
    });

    await expect(
      runtimeToken.verifyAgentRuntimeIdentityToken(token.slice(0, -1)),
    ).resolves.toBeUndefined();
  });

  it("rejects tokens minted from a different local state directory", async () => {
    useTempHome();
    const firstProcess = await importRuntimeTokenModule();
    const token = await firstProcess.mintAgentRuntimeIdentityToken({
      agentId: "main",
      sessionKey: "session-1",
      ...operationalRun(),
    });
    expect(readExecApprovals().socket?.token).toEqual(expect.any(String));

    useTempHome();
    const secondProcess = await importRuntimeTokenModule();
    const secondToken = await secondProcess.mintAgentRuntimeIdentityToken({
      agentId: "main",
      sessionKey: "session-1",
      ...operationalRun(),
    });

    expect(secondToken).not.toBe(token);
    await expect(secondProcess.verifyAgentRuntimeIdentityToken(token)).resolves.toBeUndefined();
  });

  it("round-trips signed message action context and rejects it after expiry", async () => {
    useTempHome();
    const runtimeToken = await importRuntimeTokenModule();
    const token = await runtimeToken.mintAgentRuntimeIdentityToken({
      agentId: "main",
      sessionKey: "session-1",
      ...operationalRun(),
      messageActionContext: {
        expiresAtMs: 5000,
        sourceReplyFinal: true,
        sourceReplyToolCallId: "message-call-1",
        sourceReplySessionKey: "agent:main:main",
        sessionId: "session-id-1",
        requesterAccountId: "ops",
        requesterSenderId: "sender-1",
        toolContext: {
          currentChannelProvider: "matrix",
          currentChannelId: "!room:example.org",
          currentChatType: "direct",
          currentSourceTurnId: "channel-user:v1:source-1",
        },
      },
    });

    await expect(runtimeToken.verifyAgentRuntimeIdentityToken(token, 4000)).resolves.toMatchObject({
      kind: "agentRuntime",
      agentId: "main",
      sessionKey: "session-1",
      ...operationalRun(),
      messageActionContext: {
        expiresAtMs: 5000,
        sourceReplyFinal: true,
        sourceReplyToolCallId: "message-call-1",
        sourceReplySessionKey: "agent:main:main",
        sessionId: "session-id-1",
        requesterAccountId: "ops",
        requesterSenderId: "sender-1",
        toolContext: {
          currentChannelProvider: "matrix",
          currentChannelId: "!room:example.org",
          currentChatType: "direct",
          currentSourceTurnId: "channel-user:v1:source-1",
        },
      },
    });
    await expect(
      runtimeToken.verifyAgentRuntimeIdentityToken(token, 5000),
    ).resolves.toBeUndefined();
  });

  it("bounds run-lifetime message action bearers independently of local revocation", async () => {
    useTempHome();
    const runtimeToken = await importRuntimeTokenModule();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1000);
    const token = await runtimeToken.mintAgentRuntimeIdentityToken({
      agentId: "main",
      sessionKey: "session-1",
      ...operationalRun(),
      messageActionContext: { expiresAtMs: Number.MAX_SAFE_INTEGER },
    });

    await expect(
      runtimeToken.verifyAgentRuntimeIdentityToken(token, 60_999),
    ).resolves.toMatchObject({
      messageActionContext: { expiresAtMs: 61_000 },
    });
    await expect(
      runtimeToken.verifyAgentRuntimeIdentityToken(token, 61_000),
    ).resolves.toBeUndefined();
    nowSpy.mockRestore();
  });

  it("queues parallel verifications behind a same-process approvals update", async () => {
    useTempHome();
    const runtimeToken = await importRuntimeTokenModule();
    const { updateExecApprovals } = await import("../infra/exec-approvals.js");
    const token = await runtimeToken.mintAgentRuntimeIdentityToken({
      agentId: "main",
      sessionKey: "session-1",
      ...operationalRun(),
    });
    let verifications: Array<ReturnType<typeof runtimeToken.verifyAgentRuntimeIdentityToken>> = [];

    await updateExecApprovals({
      update: () => {
        // Verification can begin while another parallel agent call still owns
        // the process-local approvals lock. It must queue behind that owner.
        verifications = Array.from({ length: 8 }, () =>
          runtimeToken.verifyAgentRuntimeIdentityToken(token),
        );
        return null;
      },
    });

    const verified = await Promise.all(verifications);
    expect(verified).toHaveLength(8);
    for (const identity of verified) {
      expect(identity).toMatchObject({
        kind: "agentRuntime",
        agentId: "main",
        sessionKey: "session-1",
        operationalRunInstance: operationalRun().operationalRunInstance,
        delegatedAuthority: { kind: "local" },
      });
    }
  });

  it("rechecks message action expiry after waiting for an approvals update", async () => {
    useTempHome();
    const runtimeToken = await importRuntimeTokenModule();
    const { updateExecApprovals } = await import("../infra/exec-approvals.js");
    const token = await runtimeToken.mintAgentRuntimeIdentityToken({
      agentId: "main",
      sessionKey: "session-1",
      ...operationalRun(),
      messageActionContext: { expiresAtMs: 5000 },
    });
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(4000);
    let verification!: ReturnType<typeof runtimeToken.verifyAgentRuntimeIdentityToken>;

    await updateExecApprovals({
      update: () => {
        verification = runtimeToken.verifyAgentRuntimeIdentityToken(token);
        nowSpy.mockReturnValue(5000);
        return null;
      },
    });

    await expect(verification).resolves.toBeUndefined();
  });
});
