// Program nodes push tests cover APNs provider outcomes through the full CLI registration.
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PushTestResult } from "../../packages/gateway-protocol/src/index.js";
import { createIosNodeListResponse } from "./program.nodes-test-helpers.js";
import { programGatewayCallMock, runtime } from "./program.test-mocks.js";

let registerNodesCli: typeof import("./nodes-cli.js").registerNodesCli;

describe("cli program (nodes push)", () => {
  let program: Command;
  let previousExitCode: NodeJS.Process["exitCode"];

  function mockPushResult(result: PushTestResult) {
    programGatewayCallMock.mockImplementation(async (...args: unknown[]) => {
      const opts = (args[0] ?? {}) as { method?: string };
      if (opts.method === "node.list") {
        return createIosNodeListResponse();
      }
      if (opts.method === "push.test") {
        return result;
      }
      return { ok: true };
    });
  }

  function runtimeOutput(): string {
    return runtime.log.mock.calls
      .map(([value]) => (typeof value === "string" ? value : (JSON.stringify(value) ?? "")))
      .join("\n");
  }

  async function runPush(extraArgs: string[] = []) {
    await program.parseAsync(["nodes", "push", "--node", "ios-node", ...extraArgs], {
      from: "user",
    });
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    previousExitCode = process.exitCode;
    process.exitCode = undefined;
    ({ registerNodesCli } = await import("./nodes-cli.js"));
    program = new Command();
    program.exitOverride();
    await registerNodesCli(program);
  });

  afterEach(() => {
    process.exitCode = previousExitCode;
  });

  it("sets a failing exit code after rendering an APNs push failure", async () => {
    mockPushResult({
      ok: false,
      status: 400,
      reason: "BadDeviceToken",
      tokenSuffix: "1234abcd",
      topic: "ai.openclaw.ios",
      environment: "sandbox",
      transport: "direct",
    });

    await runPush();

    expect(process.exitCode).toBe(1);
    expect(runtimeOutput()).toContain("push.test status=400 ok=false env=sandbox");
    expect(runtimeOutput()).toContain("reason: BadDeviceToken");
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("preserves parseable JSON before setting a failing APNs push exit code", async () => {
    const result: PushTestResult = {
      ok: false,
      status: 410,
      reason: "Unregistered",
      tokenSuffix: "1234abcd",
      topic: "ai.openclaw.ios",
      environment: "production",
      transport: "relay",
    };
    mockPushResult(result);

    await runPush(["--json"]);

    expect(process.exitCode).toBe(1);
    expect(JSON.parse(runtimeOutput())).toEqual(result);
    expect(runtime.writeJson).toHaveBeenCalledWith(result);
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it.each([
    { label: "text", extraArgs: [], environment: undefined },
    { label: "JSON", extraArgs: ["--json"], environment: undefined },
    { label: "empty environment", extraArgs: ["--environment", ""], environment: undefined },
    { label: "sandbox", extraArgs: ["--environment", " SaNdBoX "], environment: "sandbox" },
    { label: "production", extraArgs: ["--environment", "PrOdUcTiOn"], environment: "production" },
  ])(
    "keeps successful APNs push $label output at exit zero",
    async ({ extraArgs, environment }) => {
      const result: PushTestResult = {
        ok: true,
        status: 200,
        apnsId: "apns-id",
        tokenSuffix: "1234abcd",
        topic: "ai.openclaw.ios",
        environment: "sandbox",
        transport: "direct",
      };
      mockPushResult(result);

      await runPush(extraArgs);

      expect(process.exitCode).toBeUndefined();
      const pushRequest = programGatewayCallMock.mock.calls
        .map(([request]) => request as { method?: string; params?: unknown })
        .find(({ method }) => method === "push.test");
      expect(pushRequest?.params).toEqual({
        nodeId: "ios-node",
        title: "OpenClaw",
        body: "Push test for node ios-node",
        ...(environment ? { environment } : {}),
      });
      if (extraArgs.includes("--json")) {
        expect(JSON.parse(runtimeOutput())).toEqual(result);
      } else {
        expect(runtimeOutput()).toContain("push.test status=200 ok=true env=sandbox");
      }
      expect(runtime.exit).not.toHaveBeenCalled();
    },
  );
});
