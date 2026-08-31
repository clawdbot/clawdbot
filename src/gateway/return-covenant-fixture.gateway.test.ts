import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readReturnCovenantProcessStartFingerprint,
  type ReturnCovenantGatewayBinding,
} from "../auto-reply/continuation/return-covenant-fixture/gateway-generation.js";
import {
  createReturnCovenantGatewayService,
  RETURN_COVENANT_GATEWAY_METHOD,
} from "../auto-reply/continuation/return-covenant-fixture/gateway-rpc.js";
import { createReturnCovenantFixtureConfig } from "../auto-reply/continuation/return-covenant-fixture/runtime-config.js";
import {
  createReturnCovenantTestAttestation,
  createReturnCovenantTestPlan,
  createReturnCovenantTestRequest,
} from "../auto-reply/continuation/return-covenant-fixture/test-plan.test-support.js";
import { resetConfigRuntimeState } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import { callGateway } from "./call.js";
import { ADMIN_SCOPE } from "./method-scopes.js";
import { withGatewayServerExtraHandlers } from "./server-extra-handlers.js";
import { startGatewayServer } from "./server.js";

afterEach(() => {
  resetConfigRuntimeState();
  vi.unstubAllEnvs();
});

describe("return-covenant authenticated Gateway seam", () => {
  it("routes phases through the live generation and rejects bad auth, stale, and stopped use", async () => {
    const port = await getFreePort();
    const token = "return-covenant-gateway-test-token";
    const state = await createOpenClawTestState({
      label: "return-covenant-gateway-rpc",
      layout: "home",
      env: {
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
        VITEST: "1",
      },
    });
    const config: OpenClawConfig = {
      gateway: { auth: { mode: "token", token }, mode: "local", port },
      agents: {
        defaults: {
          continuation: {
            enabled: true,
            crossSessionTargeting: "disabled",
          },
        },
      },
      session: { mainKey: "main", scope: "per-sender" },
    };
    await state.writeConfig(config);
    state.applyEnv();
    const binding: ReturnCovenantGatewayBinding = {
      bootId: "return-covenant-test-generation",
      endpoint: `http://127.0.0.1:${port}`,
      pid: process.pid,
      startFingerprint: await readReturnCovenantProcessStartFingerprint(process.pid),
    };
    const service = createReturnCovenantGatewayService({
      binding,
      config: createReturnCovenantFixtureConfig(config),
      env: process.env,
    });
    const server = await startGatewayServer(
      port,
      withGatewayServerExtraHandlers(
        {
          auth: { mode: "token", token },
          bind: "loopback",
          bootId: binding.bootId,
          controlUiEnabled: false,
          sidecarStartup: "defer",
        },
        service.handlers,
      ),
    );
    const request = (requestToken: string, params: Record<string, unknown>, timeoutMs = 30_000) =>
      callGateway({
        config,
        deviceIdentity: null,
        ignoreEnvUrlOverride: true,
        method: RETURN_COVENANT_GATEWAY_METHOD,
        params,
        requiredMethods: [RETURN_COVENANT_GATEWAY_METHOD],
        scopes: [ADMIN_SCOPE],
        sharedStateMode: "read-only",
        timeoutMs,
        token: requestToken,
        url: binding.endpoint.replace(/^http:/u, "ws:"),
        useStoredDeviceAuth: false,
      });
    try {
      await server.startupSettled;
      await expect(
        request("wrong-return-covenant-token", {
          operation: "ping",
          expectedGateway: binding,
        }),
      ).rejects.toThrow();
      await expect(
        request(token, {
          operation: "ping",
          expectedGateway: binding,
        }),
      ).resolves.toMatchObject({ gateway: binding });

      const plan = createReturnCovenantTestPlan();
      await request(token, {
        operation: "initialize",
        expectedGateway: binding,
        plan,
      });
      const phase = await request(token, {
        operation: "phase",
        expectedGateway: binding,
        phaseRequest: createReturnCovenantTestRequest({
          casePlan: plan.cases[0]!,
          form: "typed-tool",
          phase: "prepare",
          plan,
        }),
        attestation: createReturnCovenantTestAttestation(plan),
      });
      expect(phase.payload).toMatchObject({
        caseHandle: expect.stringMatching(/^case-[0-9a-f]{40}$/u),
      });
      await expect(
        request(token, {
          operation: "ping",
          expectedGateway: { ...binding, bootId: "stale-return-covenant-generation" },
        }),
      ).rejects.toThrow(/stale gateway generation/u);
    } finally {
      service.beginClose();
      await service.close();
      await server.close({ reason: "return-covenant gateway seam test complete" });
      await state.cleanup();
    }
    await expect(
      request(
        token,
        {
          operation: "ping",
          expectedGateway: binding,
        },
        500,
      ),
    ).rejects.toThrow();
  }, 90_000);
});
