import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";

const envSnapshot = captureEnv(["HOME", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR"]);

const tempHomes: string[] = [];

function useTempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-runtime-"));
  tempHomes.push(home);
  setTestEnvValue("HOME", home);
  setTestEnvValue("OPENCLAW_HOME", home);
  setTestEnvValue("OPENCLAW_STATE_DIR", "");
  return home;
}

function execApprovalsPath(home: string): string {
  return path.join(home, ".openclaw", "exec-approvals.json");
}

function readExecApprovals(home: string): {
  socket?: { token?: string };
} {
  return JSON.parse(fs.readFileSync(execApprovalsPath(home), "utf8")) as {
    socket?: { token?: string };
  };
}

async function importRuntimeTokenModule(): Promise<
  typeof import("./agent-runtime-identity-token.js")
> {
  vi.resetModules();
  return await import("./agent-runtime-identity-token.js");
}

afterEach(() => {
  vi.resetModules();
  envSnapshot.restore();
  for (const home of tempHomes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

describe("agent runtime identity token", () => {
  it("persists the local signing secret so tokens verify across processes", async () => {
    const home = useTempHome();
    const firstProcess = await importRuntimeTokenModule();

    const token = await firstProcess.mintAgentRuntimeIdentityToken({
      agentId: "main",
      sessionKey: "session-1",
    });

    const persistedToken = readExecApprovals(home).socket?.token;
    expect(persistedToken).toEqual(expect.any(String));
    expect(persistedToken).not.toHaveLength(0);

    const secondProcess = await importRuntimeTokenModule();
    await expect(secondProcess.verifyAgentRuntimeIdentityToken(token)).resolves.toEqual({
      kind: "agentRuntime",
      agentId: "main",
      sessionKey: "session-1",
    });
  });

  it("does not mint local credentials while rejecting invalid presented tokens", async () => {
    const home = useTempHome();
    const runtimeToken = await importRuntimeTokenModule();

    await expect(
      runtimeToken.verifyAgentRuntimeIdentityToken("not-a-valid-token"),
    ).resolves.toBeUndefined();
    expect(fs.existsSync(execApprovalsPath(home))).toBe(false);
  });

  it("rejects tokens minted from a different local state directory", async () => {
    const firstHome = useTempHome();
    const firstProcess = await importRuntimeTokenModule();
    const token = await firstProcess.mintAgentRuntimeIdentityToken({
      agentId: "main",
      sessionKey: "session-1",
    });
    expect(fs.existsSync(execApprovalsPath(firstHome))).toBe(true);

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
        sessionId: "session-id-1",
        requesterAccountId: "ops",
        requesterSenderId: "sender-1",
        toolContext: {
          currentChannelProvider: "matrix",
          currentChannelId: "!room:example.org",
          currentChatType: "direct",
        },
      },
    });

    await expect(runtimeToken.verifyAgentRuntimeIdentityToken(token, 4000)).resolves.toMatchObject({
      kind: "agentRuntime",
      agentId: "main",
      sessionKey: "session-1",
      messageActionContext: {
        expiresAtMs: 5000,
        sessionId: "session-id-1",
        requesterAccountId: "ops",
        requesterSenderId: "sender-1",
        toolContext: {
          currentChannelProvider: "matrix",
          currentChannelId: "!room:example.org",
          currentChatType: "direct",
        },
      },
    });
    await expect(
      runtimeToken.verifyAgentRuntimeIdentityToken(token, 5000),
    ).resolves.toBeUndefined();
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
