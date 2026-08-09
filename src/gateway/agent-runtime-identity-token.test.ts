import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readExecApprovalsSnapshot } from "../infra/exec-approvals-store.js";
import { testing as execApprovalsStoreTesting } from "../infra/exec-approvals-store.test-support.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";

const envSnapshot = captureEnv(["HOME", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR"]);

const tempHomes: string[] = [];

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

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  execApprovalsStoreTesting.reset();
  vi.resetModules();
  envSnapshot.restore();
  for (const home of tempHomes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

describe("agent runtime identity token", () => {
  it("persists the local signing secret so tokens verify across processes", async () => {
    useTempHome();
    const firstProcess = await importRuntimeTokenModule();

    const token = await firstProcess.mintAgentRuntimeIdentityToken({
      agentId: "main",
      sessionKey: "session-1",
    });

    const persistedToken = readExecApprovals().socket?.token;
    expect(persistedToken).toEqual(expect.any(String));
    expect(persistedToken).not.toHaveLength(0);

    const secondProcess = await importRuntimeTokenModule();
    await expect(secondProcess.verifyAgentRuntimeIdentityToken(token)).resolves.toEqual({
      kind: "agentRuntime",
      agentId: "main",
      sessionKey: "session-1",
    });
  });

  it("round-trips the authenticated turn-source account", async () => {
    useTempHome();
    const runtimeToken = await importRuntimeTokenModule();
    const token = await runtimeToken.mintAgentRuntimeIdentityToken({
      agentId: "main",
      sessionKey: "session-1",
      turnSourceAccountId: " Work ",
    });

    await expect(runtimeToken.verifyAgentRuntimeIdentityToken(token)).resolves.toEqual({
      kind: "agentRuntime",
      agentId: "main",
      sessionKey: "session-1",
      turnSourceAccountId: "work",
    });
  });

  it("round-trips a signed visible-session spawn policy", async () => {
    useTempHome();
    const runtimeToken = await importRuntimeTokenModule();
    const token = await runtimeToken.mintAgentRuntimeIdentityToken({
      agentId: "main",
      sessionKey: "agent:main:main",
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
      cronSelfManagementJobId: " job-1 ",
    });

    await expect(runtimeToken.verifyAgentRuntimeIdentityToken(token, 60_999)).resolves.toEqual({
      kind: "agentRuntime",
      agentId: "ops",
      sessionKey: "agent:ops:cron:job-1:run:run-1",
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
    const token = await runtimeToken.mintAgentRuntimeIdentityToken({
      agentId: "main",
      sessionKey: "agent:main:main",
      cronToolsAllowCapture: "final-executable-surface",
    });

    await expect(runtimeToken.verifyAgentRuntimeIdentityToken(token)).resolves.toEqual({
      kind: "agentRuntime",
      agentId: "main",
      sessionKey: "agent:main:main",
      cronToolsAllowCapture: "final-executable-surface",
    });
  });

  it("round-trips a signed private cron creator grant only with final provenance", async () => {
    useTempHome();
    const runtimeToken = await importRuntimeTokenModule();
    const cronCreatorAuthorityGrant = { runId: "run-1", token: "opaque-grant" };
    const token = await runtimeToken.mintAgentRuntimeIdentityToken({
      agentId: "main",
      sessionKey: "agent:main:main",
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
    });
    expect(readExecApprovals().socket?.token).toEqual(expect.any(String));

    useTempHome();
    const secondProcess = await importRuntimeTokenModule();
    const secondToken = await secondProcess.mintAgentRuntimeIdentityToken({
      agentId: "main",
      sessionKey: "session-1",
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

    await expect(Promise.all(verifications)).resolves.toEqual(
      Array.from({ length: 8 }, () => ({
        kind: "agentRuntime",
        agentId: "main",
        sessionKey: "session-1",
      })),
    );
  });

  it("rechecks message action expiry after waiting for an approvals update", async () => {
    useTempHome();
    const runtimeToken = await importRuntimeTokenModule();
    const { updateExecApprovals } = await import("../infra/exec-approvals.js");
    const token = await runtimeToken.mintAgentRuntimeIdentityToken({
      agentId: "main",
      sessionKey: "session-1",
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
