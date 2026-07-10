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
    expect(secondProcess.verifyAgentRuntimeIdentityToken(token)).toEqual({
      kind: "agentRuntime",
      agentId: "main",
      sessionKey: "session-1",
    });
  });

  it("does not mint local credentials while rejecting invalid presented tokens", async () => {
    const home = useTempHome();
    const runtimeToken = await importRuntimeTokenModule();

    expect(runtimeToken.verifyAgentRuntimeIdentityToken("not-a-valid-token")).toBeUndefined();
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
    expect(secondProcess.verifyAgentRuntimeIdentityToken(token)).toBeUndefined();
  });
});
