import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalEnv = {
  HOME: process.env.HOME,
  OPENCLAW_HOME: process.env.OPENCLAW_HOME,
};

const tempHomes: string[] = [];

function useTempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-approval-runtime-"));
  tempHomes.push(home);
  process.env.HOME = home;
  process.env.OPENCLAW_HOME = home;
  return home;
}

function execApprovalsPath(home: string): string {
  return path.join(home, ".openclaw", "exec-approvals.json");
}

function writeExecApprovalsToken(home: string, token: string): void {
  fs.mkdirSync(path.join(home, ".openclaw"), { recursive: true });
  fs.writeFileSync(
    execApprovalsPath(home),
    `${JSON.stringify(
      {
        version: 1,
        socket: {
          path: "~/.openclaw/exec-approvals.sock",
          token,
        },
        agents: {},
      },
      null,
      2,
    )}\n`,
  );
}

async function importRuntimeTokenModule(): Promise<
  typeof import("./operator-approval-runtime-token.js")
> {
  vi.resetModules();
  return await import("./operator-approval-runtime-token.js");
}

afterEach(() => {
  vi.resetModules();
  if (originalEnv.HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalEnv.HOME;
  }
  if (originalEnv.OPENCLAW_HOME === undefined) {
    delete process.env.OPENCLAW_HOME;
  } else {
    process.env.OPENCLAW_HOME = originalEnv.OPENCLAW_HOME;
  }
  for (const home of tempHomes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

describe("operator approval runtime token", () => {
  it("derives the shared approval runtime token from the exec approvals socket token", async () => {
    const home = useTempHome();
    writeExecApprovalsToken(home, "shared-runtime-token");

    const runtimeToken = await importRuntimeTokenModule();
    const sharedToken = runtimeToken.getOperatorApprovalRuntimeToken();

    expect(sharedToken).toEqual(expect.any(String));
    expect(sharedToken).not.toBe("shared-runtime-token");
    expect(runtimeToken.isOperatorApprovalRuntimeToken(` ${sharedToken} `)).toBe(true);
    expect(runtimeToken.isOperatorApprovalRuntimeToken("shared-runtime-token")).toBe(false);
    expect(runtimeToken.isOperatorApprovalRuntimeToken("different-token")).toBe(false);
  });

  it("does not pin the process fallback once a shared exec approvals token appears", async () => {
    const home = useTempHome();
    const runtimeToken = await importRuntimeTokenModule();

    const fallback = runtimeToken.getOperatorApprovalRuntimeToken();
    writeExecApprovalsToken(home, "late-shared-runtime-token");
    const sharedToken = runtimeToken.getOperatorApprovalRuntimeToken();

    expect(sharedToken).not.toBe(fallback);
    expect(sharedToken).not.toBe("late-shared-runtime-token");
    expect(runtimeToken.isOperatorApprovalRuntimeToken(fallback)).toBe(true);
    expect(runtimeToken.isOperatorApprovalRuntimeToken(sharedToken)).toBe(true);
    expect(runtimeToken.isOperatorApprovalRuntimeToken("late-shared-runtime-token")).toBe(false);
  });

  it("keeps a stable process fallback without creating exec-approvals.json", async () => {
    const home = useTempHome();
    const runtimeToken = await importRuntimeTokenModule();

    const first = runtimeToken.getOperatorApprovalRuntimeToken();
    const second = runtimeToken.getOperatorApprovalRuntimeToken();

    expect(first).toEqual(expect.any(String));
    expect(second).toBe(first);
    expect(fs.existsSync(execApprovalsPath(home))).toBe(false);
  });
});
