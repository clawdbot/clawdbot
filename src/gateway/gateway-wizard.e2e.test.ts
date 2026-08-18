import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  WizardNextResult,
  WizardStartResult,
} from "../../packages/gateway-protocol/src/index.js";
import {
  nextGatewayId,
  removeGatewayTempHome,
  resetGatewayTestState,
  setupGatewayTempHome,
} from "./gateway.test-support.js";
import { startGatewayServer } from "./server.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  getGatewayE2ePortBlock,
} from "./test-helpers.e2e.js";

const GATEWAY_E2E_TIMEOUT_MS = 90_000;

describe("gateway wizard e2e", () => {
  beforeEach(resetGatewayTestState);
  afterEach(resetGatewayTestState);

  it("contains hosted wizard exits", { timeout: GATEWAY_E2E_TIMEOUT_MS }, async () => {
    const { envSnapshot, tempHome } = await setupGatewayTempHome({
      prefix: "openclaw-wizard-contained-exit-home-",
      minimalGateway: true,
    });
    const wizardToken = nextGatewayId("wiz-contained-exit");
    let exitCode = 0;
    const port = await getGatewayE2ePortBlock();
    const server = await startGatewayServer(port, {
      bind: "loopback",
      auth: { mode: "token", token: wizardToken },
      controlUiEnabled: false,
      wizardRunner: async (_opts, runtime, prompter) => {
        await prompter.outro("wizard complete");
        runtime.exit(exitCode);
      },
      channelWizardRunner: async (_opts, runtime, prompter) => {
        await prompter.outro("channel wizard complete");
        runtime.exit(exitCode);
      },
    });
    const client = await connectGatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: wizardToken,
    });
    // Intercept an actual host exit so the fail-first Gateway test cannot
    // terminate its Vitest worker before reporting the regression.
    const processExit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`Gateway process exit ${code}`);
    });

    try {
      for (const flow of ["setup", "channels"] as const) {
        for (const nextExitCode of [0, 23] as const) {
          exitCode = nextExitCode;
          const status = exitCode === 0 ? "done" : "error";
          const start = await client.request<WizardStartResult>(
            "wizard.start",
            flow === "channels" ? { flow } : { mode: "local" },
          );
          expect(start).toMatchObject({ done: false, status: "running" });
          expect(start.step?.id).toBeTruthy();

          const result = await client.request<WizardNextResult>("wizard.next", {
            sessionId: start.sessionId,
            answer: { stepId: start.step?.id, value: null },
          });
          expect(result).toMatchObject({ done: true, status });
          if (exitCode !== 0) {
            expect(result.error).toContain(String(exitCode));
          }
          expect(processExit).not.toHaveBeenCalled();
          await expect(client.request("health", {})).resolves.toBeDefined();
        }
      }
    } finally {
      processExit.mockRestore();
      await disconnectGatewayClient(client);
      await server.close({ reason: "wizard runtime isolation E2E complete" });
      await removeGatewayTempHome(tempHome);
      envSnapshot.restore();
    }
  });

  it(
    "routes wizard.start flow channels to the channel wizard runner",
    { timeout: GATEWAY_E2E_TIMEOUT_MS },
    async () => {
      const { envSnapshot, tempHome } = await setupGatewayTempHome({
        prefix: "openclaw-wizard-channels-home-",
        minimalGateway: true,
      });
      const wizAuth = nextGatewayId("wiz-chan");
      const port = await getGatewayE2ePortBlock();
      const channelRuns: Array<string | undefined> = [];
      const server = await startGatewayServer(port, {
        bind: "loopback",
        auth: { mode: "token", token: wizAuth },
        controlUiEnabled: false,
        wizardRunner: async () => {
          throw new Error("setup wizard runner must not run for flow channels");
        },
        channelWizardRunner: async (opts, _runtime, prompter) => {
          channelRuns.push(opts.channel);
          await prompter.intro("Channel setup");
          const choice = await prompter.select({
            message: "channel",
            options: [{ value: opts.channel ?? "none", label: opts.channel ?? "none" }],
          });
          opts.onConfigured?.([{ channel: choice, accountId: "default" }]);
          await prompter.outro(`configured ${choice}`);
        },
      });

      const client = await connectGatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token: wizAuth,
        clientDisplayName: "vitest-wizard-channels",
      });

      try {
        for (const testCase of [
          { label: "omitted", channel: undefined, expected: "none" },
          { label: "canonical", channel: "telegram", expected: "telegram" },
          { label: "alias", channel: "imsg", expected: "imsg" },
        ]) {
          const start = await client.request<WizardStartResult>("wizard.start", {
            flow: "channels",
            ...(testCase.channel === undefined ? {} : { channel: testCase.channel }),
          });
          const sessionId = start.sessionId;
          expect(typeof sessionId, testCase.label).toBe("string");

          let next: WizardStartResult | WizardNextResult = start;
          const seenSteps: string[] = [];
          while (!next.done) {
            const step = next.step;
            if (!step) {
              throw new Error("wizard missing step");
            }
            seenSteps.push(step.type);
            next = await client.request<WizardNextResult>(
              "wizard.next",
              {
                sessionId,
                answer: {
                  stepId: step.id,
                  value: step.type === "select" ? testCase.expected : null,
                },
              },
              { timeoutMs: 60_000 },
            );
          }

          expect(next.status, `${testCase.label}: seenSteps=${seenSteps.join(",")}`).toBe("done");
          expect(seenSteps, testCase.label).toContain("select");
          expect(next.channels, testCase.label).toEqual([testCase.expected]);
          expect(next.accounts, testCase.label).toEqual([
            { channel: testCase.expected, accountId: "default" },
          ]);
        }
        expect(channelRuns).toEqual([undefined, "telegram", "imsg"]);
      } finally {
        await disconnectGatewayClient(client);
        await server.close({ reason: "wizard channels flow complete" });
        await removeGatewayTempHome(tempHome);
        envSnapshot.restore();
      }
    },
  );
});
