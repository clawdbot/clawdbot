import { describe, expect, it, vi } from "vitest";
import {
  qaScenarioModuleFlow,
  runQaAccessControlScenarioFlow,
  runQaRestartResumeScenarioFlow,
} from "./scenario-module-flow.js";
import type { QaSuiteRuntimeEnv } from "./suite-runtime-types.js";

describe("QA scenario module flow", () => {
  it("resolves a module export argument against the loaded scenario module", () => {
    const flow = qaScenarioModuleFlow.moduleSchema.parse({
      module: "./scenario-runtime.js",
      call: "runScenario",
      args: [{ expr: "scenarioContext" }, { moduleExport: "scenarioImplementation" }],
    });

    expect(qaScenarioModuleFlow.resolveKind(flow)).toBe("module");
    expect(qaScenarioModuleFlow.resolveFlow(flow, "Scenario title")).toMatchObject({
      steps: [
        {
          actions: [
            {
              set: "scenarioModule",
              value: { expr: 'await qaImport("./scenario-runtime.js")' },
            },
            {
              args: [
                { expr: "scenarioContext" },
                { expr: 'scenarioModule["scenarioImplementation"]' },
              ],
              call: "scenarioModule.runScenario",
            },
          ],
        },
      ],
    });
  });

  it("distinguishes module syntax without relying on its source path", () => {
    const moduleFlow = qaScenarioModuleFlow.moduleSchema.parse({
      module: "example-package/scenario.js",
      call: "runScenario",
    });

    expect(qaScenarioModuleFlow.resolveKind(moduleFlow)).toBe("module");
    expect(qaScenarioModuleFlow.resolveKind({ steps: [] })).toBe("steps");
    expect(qaScenarioModuleFlow.resolveKind(undefined)).toBeUndefined();
  });

  it("rejects malformed module export arguments", () => {
    expect(() =>
      qaScenarioModuleFlow.moduleSchema.parse({
        module: "./scenario-runtime.js",
        call: "runScenario",
        args: [{ moduleExport: "" }],
      }),
    ).toThrow("moduleExport arguments require a non-empty string export name");
  });

  it.each([true, false])(
    "runs the shared access-control branch expectReply=%s",
    async (expectReply) => {
      const transport = {
        reset: vi.fn(async () => {}),
        sendInbound: vi.fn(async () => ({}) as never),
        waitForNoOutbound: vi.fn(async () => {}),
        waitForOutbound: vi.fn(async () => ({}) as never),
      };
      const result = await runQaAccessControlScenarioFlow({
        config: {
          conversationId: "conversation",
          conversationKind: "direct",
          expectReply,
          markerPrefix: "ACCESS",
          mentionPrefix: "",
          senderId: "sender",
          timeoutMs: 8_000,
        },
        env: { gateway: {} },
        getTransportSnapshot: () => ({ messages: [{ direction: "outbound" }] }) as never,
        randomUUID: () => "abcdef12-rest",
        transport,
        waitForGatewayHealthy: vi.fn(async () => {}),
        waitForTransportReady: vi.fn(async () => {}),
      });

      expect(transport.sendInbound).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Reply with only this exact marker: ACCESS_ABCDEF12" }),
      );
      expect(transport.waitForOutbound).toHaveBeenCalledTimes(expectReply ? 1 : 0);
      expect(transport.waitForNoOutbound).toHaveBeenCalledTimes(expectReply ? 0 : 1);
      expect(result.details).toBe(`ACCESS: expectReply=${expectReply}`);
    },
  );

  it("runs the shared restart flow on both sides of the gateway lifecycle", async () => {
    const transport = {
      reset: vi.fn(async () => {}),
      sendInbound: vi.fn(async () => ({}) as never),
      waitForNoOutbound: vi.fn(async () => {}),
      waitForOutbound: vi.fn(async () => ({}) as never),
    };
    const restartAfterStateMutation: NonNullable<
      QaSuiteRuntimeEnv["gateway"]["restartAfterStateMutation"]
    > = vi.fn(
      async (mutate) =>
        await mutate({ configPath: "", runtimeEnv: {}, stateDir: "", tempRoot: "" }),
    );
    const waitForGatewayHealthy = vi.fn(async () => {});
    const waitForTransportReady = vi.fn(async () => {});

    const result = await runQaRestartResumeScenarioFlow({
      config: {
        conversationId: "conversation",
        conversationKind: "group",
        firstPrefix: "BEFORE",
        mentionPrefix: "@openclaw ",
        secondPrefix: "AFTER",
        senderId: "sender",
        timeoutMs: 60_000,
      },
      env: { gateway: { restartAfterStateMutation } },
      randomUUID: vi
        .fn<() => string>()
        .mockReturnValueOnce("11111111-rest")
        .mockReturnValueOnce("22222222-rest"),
      transport,
      waitForGatewayHealthy,
      waitForTransportReady,
    });

    expect(transport.sendInbound).toHaveBeenCalledTimes(2);
    expect(transport.waitForOutbound).toHaveBeenCalledTimes(2);
    expect(restartAfterStateMutation).toHaveBeenCalledOnce();
    expect(waitForGatewayHealthy).toHaveBeenCalledTimes(2);
    expect(waitForTransportReady).toHaveBeenCalledTimes(2);
    expect(result.details).toBe("BEFORE_11111111 -> restart -> AFTER_22222222");
  });
});
