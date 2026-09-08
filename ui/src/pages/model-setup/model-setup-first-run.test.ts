/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { WizardNextResult } from "../../api/types.ts";
import { i18n } from "../../i18n/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { clearFirstRunActivationReceipt } from "./first-run-activation-receipt.ts";
import {
  candidate,
  clickCandidate,
  createFirstRunContext,
  detection,
  mountPage,
  requestParameters,
} from "./model-setup-first-run.test-support.ts";

describe("ModelSetupPage first-run inference", () => {
  beforeEach(async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    localStorage.setItem(
      "openclaw-device-identity-v1",
      JSON.stringify({ version: 1, privateKey: "durable-device-private-key-for-testing" }),
    );
    await i18n.setLocale("en");
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(["rejected", "uncertain"] as const)(
    "stops after a %s candidate and only permits retry after a proven rejection",
    async (outcome) => {
      const { context, client, request } = createFirstRunContext();
      request.mockResolvedValue({
        done: true,
        status: "error",
        error: "The model could not finish setup",
        ...(outcome === "rejected"
          ? { activationRejection: { disposition: "rejected-before-promotion", status: "auth" } }
          : {}),
      });
      const { page } = await mountPage(context, {
        state: {
          phase: "ready",
          result: {
            ...detection,
            candidates: [
              candidate("claude-cli", "provider/signed-out", false),
              candidate("openai-api-key", "provider/expired", true),
              candidate("provider-auto:local", "provider/other"),
            ],
          },
        },
        client,
        firstRun: true,
      });
      expect(request).not.toHaveBeenCalled();
      await clickCandidate(page, "openai-api-key");
      await waitForFast(() =>
        expect(page.textContent).toContain("The model could not finish setup"),
      );
      expect(request).toHaveBeenCalledOnce();
      expect(context.navigate).not.toHaveBeenCalled();
      const retry = page.querySelector<HTMLButtonElement>(
        '[data-candidate-kind="openai-api-key"] button',
      )!;
      expect(retry.disabled).toBe(outcome === "uncertain");
      expect(localStorage.getItem("openclaw.modelSetup.pendingActivation.v1") === null).toBe(
        outcome === "rejected",
      );
      [...page.querySelectorAll<HTMLButtonElement>("openclaw-modal-dialog button")]
        .find((button) => button.textContent?.trim() === "Close")!
        .click();
      await page.updateComplete;
      expect(page.querySelector(".model-setup__recovery") !== null).toBe(outcome === "uncertain");
      retry.click();
      await page.updateComplete;
      expect(request).toHaveBeenCalledTimes(outcome === "rejected" ? 2 : 1);
    },
  );

  it("requires a click to activate newly discovered credentials after checking again", async () => {
    const { context, client, request } = createFirstRunContext();
    request.mockImplementation(async (method) => {
      if (method === "openclaw.setup.detect") {
        return {
          ...detection,
          candidates: [candidate("openai-api-key", "openai/newly-available", true)],
        };
      }
      if (method === "openclaw.setup.activate.start") {
        return {
          done: true,
          status: "done",
          modelActivation: { modelRef: "openai/newly-available" },
        };
      }
      throw new Error(`Unexpected method ${method}`);
    });

    const { page } = await mountPage(context, {
      state: { phase: "ready", result: detection },
      client,
      firstRun: true,
    });
    const checkAgain = page.querySelector<HTMLButtonElement>(".model-setup__intro .btn");
    expect(checkAgain?.textContent).toContain("Check again");
    checkAgain?.click();
    await waitForFast(() => expect(page.textContent).toContain("openai/newly-available"));
    expect(request.mock.calls.map(([method]) => method)).toEqual(["openclaw.setup.detect"]);
    await clickCandidate(page, "openai-api-key");

    await waitForFast(() => {
      expect(request.mock.calls.map(([method, params]) => [method, params])).toEqual([
        ["openclaw.setup.detect", { agentId: "main" }],
        [
          "openclaw.setup.activate.start",
          {
            sessionId: expect.any(String),
            agentId: "main",
            kind: "openai-api-key",
            modelRef: "openai/newly-available",
          },
        ],
      ]);
      expect(context.navigate).toHaveBeenCalledWith("custodian", { search: "?onboarding=1" });
    });
  });

  it.each(["transport", "unavailable", "busy", "not dispatched"])(
    "stops the selected candidate after %s and only retries known non-admission explicitly",
    async (failure) => {
      const { context, client, request } = createFirstRunContext();
      const message = "Setup request could not finish";
      if (failure === "not dispatched") {
        vi.mocked(context.runtimeConfig.runExternalMutation).mockResolvedValueOnce({
          ok: false,
          reason: "unavailable",
          error: message,
        });
      }
      request.mockRejectedValue(
        failure === "transport"
          ? new Error(message)
          : new GatewayRequestError({
              code: "UNAVAILABLE",
              message,
              retryable: true,
              ...(failure === "busy" ? { details: { code: "SETUP_ADMISSION_BUSY" } } : {}),
            }),
      );

      const { page } = await mountPage(context, {
        state: {
          phase: "ready",
          result: {
            ...detection,
            candidates: [
              candidate("openai-api-key", "openai/first", true),
              candidate("anthropic-api-key", "anthropic/second", true),
            ],
          },
        },
        client,
        firstRun: true,
      });
      expect(request).not.toHaveBeenCalled();
      await clickCandidate(page, "openai-api-key");

      await waitForFast(() => {
        expect(page.textContent).toContain(message);
      });
      expect(
        request.mock.calls.filter(([method]) => method === "openclaw.setup.activate.start"),
      ).toHaveLength(failure === "not dispatched" ? 0 : 1);
      const retryable = failure === "busy" || failure === "not dispatched";
      expect(localStorage.getItem("openclaw.modelSetup.pendingActivation.v1") === null).toBe(
        retryable,
      );
      expect(page.textContent).not.toContain("Connection verified");
      expect(context.navigate).not.toHaveBeenCalled();
      const retry = page.querySelector<HTMLButtonElement>(
        '[data-candidate-kind="openai-api-key"] button',
      )!;
      expect(retry.disabled).toBe(!retryable);
      if (retryable) {
        [...page.querySelectorAll<HTMLButtonElement>("openclaw-modal-dialog button")]
          .find((button) => button.textContent?.trim() === "Close")!
          .click();
        await page.updateComplete;
        retry.click();
        await waitForFast(() =>
          expect(
            request.mock.calls.filter(([method]) => method === "openclaw.setup.activate.start"),
          ).toHaveLength(failure === "not dispatched" ? 1 : 2),
        );
        for (const [, params] of request.mock.calls.filter(
          ([method]) => method === "openclaw.setup.activate.start",
        )) {
          expect(requestParameters(params)).toMatchObject({ modelRef: "openai/first" });
        }
      }
    },
  );

  it("verifies an existing first-run model before entering chat or offering continuation", async () => {
    const { context, client, request } = createFirstRunContext();
    let resolveVerification:
      | ((result: { ok: true; modelRef: string; latencyMs: number }) => void)
      | undefined;
    request.mockImplementation(async (method) => {
      if (method !== "openclaw.setup.verify") {
        throw new Error(`Unexpected method ${method}`);
      }
      return await new Promise<{ ok: true; modelRef: string; latencyMs: number }>((resolve) => {
        resolveVerification = resolve;
      });
    });

    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: { ...detection, configuredModel: "openai/existing", setupComplete: true },
      },
      client,
      firstRun: true,
    });

    expect(request).not.toHaveBeenCalled();
    page.querySelector<HTMLButtonElement>(".model-setup__current button")!.click();
    await waitForFast(() => expect(resolveVerification).toBeTypeOf("function"));
    expect(page.textContent).not.toContain("Continue setup");
    expect(context.navigate).not.toHaveBeenCalled();
    resolveVerification?.({ ok: true, modelRef: "openai/existing", latencyMs: 42 });

    await waitForFast(() => expect(page.querySelector(".model-setup__verified")).not.toBeNull());
    expect(context.navigate).not.toHaveBeenCalled();
    [...page.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Continue setup"))!
      .click();
    expect(context.navigate).toHaveBeenCalledWith("chat");
    expect(request).toHaveBeenCalledOnce();
  });

  it("does not offer verification when the Gateway does not advertise it", async () => {
    const { context, client, request, snapshot } = createFirstRunContext();
    snapshot.hello.features.methods = snapshot.hello.features.methods.filter(
      (method) => method !== "openclaw.setup.verify",
    );

    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: { ...detection, configuredModel: "openai/existing", setupComplete: true },
      },
      client,
      firstRun: true,
    });

    expect(page.querySelector(".model-setup__current button")).toBeNull();
    expect(page.textContent).not.toContain("Continue setup");
    expect(request).not.toHaveBeenCalled();
    expect(context.navigate).not.toHaveBeenCalled();
  });

  it("repairs definitively failed existing setup with a different credentialed candidate", async () => {
    const { context, client, request } = createFirstRunContext();
    request.mockImplementation(async (method) => {
      if (method === "openclaw.setup.verify") {
        return { ok: false, status: "auth", error: "The saved login expired" };
      }
      if (method === "openclaw.setup.activate.start") {
        return {
          done: true,
          status: "done",
          modelActivation: { modelRef: "anthropic/replacement" },
        };
      }
      throw new Error(`Unexpected method ${method}`);
    });

    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          configuredModel: "openai/existing",
          setupComplete: true,
          candidates: [
            candidate("existing-model", "openai/existing", true),
            candidate("openai-api-key", "openai/existing", true),
            candidate("anthropic-api-key", "anthropic/replacement", true),
          ],
        },
      },
      client,
      firstRun: true,
    });

    expect(request).not.toHaveBeenCalled();
    page.querySelector<HTMLButtonElement>(".model-setup__current button")!.click();
    await waitForFast(() => expect(page.textContent).toContain("The saved login expired"));
    expect(request).toHaveBeenCalledOnce();
    await clickCandidate(page, "anthropic-api-key");

    await waitForFast(() => {
      expect(request.mock.calls.map(([method, params]) => [method, params])).toEqual([
        ["openclaw.setup.verify", { agentId: "main" }],
        [
          "openclaw.setup.activate.start",
          {
            sessionId: expect.any(String),
            agentId: "main",
            kind: "anthropic-api-key",
            modelRef: "anthropic/replacement",
          },
        ],
      ]);
      expect(context.navigate).toHaveBeenCalledWith("custodian", { search: "?onboarding=1" });
    });
  });

  it.each(["transport", "unavailable"])(
    "keeps the selected model through verification recovery: %s",
    async (failure) => {
      const { context, client, request } = createFirstRunContext();
      const error = "Gateway settings are saved but not active yet. Retry after the restart.";
      if (failure === "transport") {
        request.mockRejectedValue(new Error(error));
      } else {
        request.mockResolvedValue({ ok: false, status: "unavailable", error });
      }

      const { page } = await mountPage(context, {
        state: {
          phase: "ready",
          result: {
            ...detection,
            configuredModel: "openai/existing",
            setupComplete: true,
            candidates: [candidate("anthropic-api-key", "anthropic/replacement", true)],
          },
        },
        client,
        firstRun: true,
      });

      expect(request).not.toHaveBeenCalled();
      page.querySelector<HTMLButtonElement>(".model-setup__current button")!.click();
      await waitForFast(() => {
        expect(page.textContent).toContain(error);
      });
      expect(page.textContent).not.toContain("Continue setup");
      expect(request).toHaveBeenCalledOnce();
      expect(context.navigate).not.toHaveBeenCalled();
      const retry = page.querySelector<HTMLButtonElement>(".model-setup__current button")!;
      expect(retry.disabled).toBe(false);
      request.mockResolvedValueOnce({ ok: true, modelRef: "openai/existing", latencyMs: 31 });
      retry.click();
      await waitForFast(() => expect(page.querySelector(".model-setup__verified")).not.toBeNull());
      const continueSetup = [...page.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
        button.textContent?.includes("Continue setup"),
      )!;
      continueSetup.click();
      expect(context.navigate).toHaveBeenCalledWith("chat");
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "openclaw.setup.verify",
        "openclaw.setup.verify",
      ]);
    },
  );

  it("keeps a successfully committed first-run setup visible when config refresh fails", async () => {
    const { context, client, request } = createFirstRunContext(
      "config.get failed after model commit",
    );
    request.mockResolvedValue({
      done: true,
      status: "done",
      modelActivation: { modelRef: "openai/new" },
    });

    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          candidates: [candidate("openai-api-key", "openai/new", true)],
        },
      },
      client,
      firstRun: true,
    });
    expect(request).not.toHaveBeenCalled();
    await clickCandidate(page, "openai-api-key");

    await waitForFast(() => {
      expect(page.textContent).toContain("Connection verified");
      expect(page.textContent).toContain("config.get failed after model commit");
    });
    expect(context.navigate).not.toHaveBeenCalled();
    clearFirstRunActivationReceipt();
    await page.updateComplete;
    expect(page.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(page.textContent).not.toContain("Connection verified");
    expect(context.navigate).not.toHaveBeenCalled();
  });

  it("waits for the replacement Gateway to verify a committed model before onboarding", async () => {
    const { context, client, request, snapshot, publishGatewaySnapshot } = createFirstRunContext();
    request.mockImplementation(async (method) => {
      if (method === "openclaw.setup.activate.start") {
        return {
          done: true,
          status: "done",
          modelActivation: { modelRef: "openai/new", gatewayRestartRequired: true },
        };
      }
      if (method === "openclaw.setup.detect") {
        return { ...detection, configuredModel: "openai/new", setupComplete: true };
      }
      if (method === "openclaw.setup.verify") {
        return { ok: true, modelRef: "openai/new", latencyMs: 31 };
      }
      throw new Error(`Unexpected method ${method}`);
    });

    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          candidates: [candidate("openai-api-key", "openai/new", true)],
        },
      },
      client,
      firstRun: true,
    });
    expect(request).not.toHaveBeenCalled();
    await clickCandidate(page, "openai-api-key");

    await waitForFast(() => {
      expect(page.textContent).toContain("The Gateway is restarting");
    });
    expect(context.navigate).not.toHaveBeenCalled();
    expect(page.textContent).not.toContain("Continue setup");

    publishGatewaySnapshot({
      ...context.gateway.snapshot,
      phase: "reconnecting",
      hello: null,
    });
    await page.updateComplete;
    publishGatewaySnapshot({
      ...snapshot,
      phase: "connected",
      hello: { ...snapshot.hello },
    });

    await waitForFast(() => {
      expect(
        request.mock.calls
          .map(([method]) => method)
          .filter((method) => method.startsWith("openclaw.setup.")),
      ).toEqual([
        "openclaw.setup.activate.start",
        "openclaw.setup.detect",
        "openclaw.setup.verify",
      ]);
      expect(context.navigate).toHaveBeenCalledWith("custodian", { search: "?onboarding=1" });
    });
  });

  it("finishes onboarding when the Gateway reconnects before its activation response", async () => {
    const { context, client, request, snapshot, publishGatewaySnapshot } = createFirstRunContext();
    let resolveActivation: ((result: WizardNextResult) => void) | undefined;
    request.mockImplementation(async (method) => {
      if (method === "openclaw.setup.activate.start") {
        return await new Promise<WizardNextResult>((resolve) => {
          resolveActivation = resolve;
        });
      }
      if (method === "openclaw.setup.detect") {
        return { ...detection, configuredModel: "openai/new", setupComplete: true };
      }
      if (method === "openclaw.setup.verify") {
        return { ok: true, modelRef: "openai/new", latencyMs: 31 };
      }
      throw new Error(`Unexpected method ${method}`);
    });

    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          candidates: [candidate("openai-api-key", "openai/new", true)],
        },
      },
      client,
      firstRun: true,
    });
    expect(request).not.toHaveBeenCalled();
    await clickCandidate(page, "openai-api-key");
    await waitForFast(() => expect(resolveActivation).toBeTypeOf("function"));

    publishGatewaySnapshot({
      ...context.gateway.snapshot,
      phase: "reconnecting",
      hello: null,
    });
    await page.updateComplete;
    publishGatewaySnapshot({
      ...snapshot,
      phase: "connected",
      hello: { ...snapshot.hello },
    });

    await waitForFast(() => {
      expect(
        request.mock.calls
          .map(([method]) => method)
          .filter((method) => method.startsWith("openclaw.setup.")),
      ).toEqual([
        "openclaw.setup.activate.start",
        "openclaw.setup.detect",
        "openclaw.setup.verify",
      ]);
      expect(context.navigate).toHaveBeenCalledWith("custodian", { search: "?onboarding=1" });
    });
    expect(context.navigate).not.toHaveBeenCalledWith("chat");
    resolveActivation?.({
      done: true,
      status: "done",
      modelActivation: { modelRef: "openai/new", gatewayRestartRequired: true },
    });
  });

  it("does not repeat an unconfirmed activation after reconnect without an explicit retry", async () => {
    const { context, client, request, snapshot, publishGatewaySnapshot } = createFirstRunContext();
    let resolveFirstActivation: ((result: WizardNextResult) => void) | undefined;
    let activationCount = 0;
    request.mockImplementation(async (method) => {
      if (method === "openclaw.setup.activate.start") {
        activationCount += 1;
        if (activationCount === 1) {
          return await new Promise<WizardNextResult>((resolve) => {
            resolveFirstActivation = resolve;
          });
        }
        return { done: true, status: "done", modelActivation: { modelRef: "openai/new" } };
      }
      if (method === "openclaw.setup.detect") {
        return {
          ...detection,
          candidates: [candidate("openai-api-key", "openai/new", true)],
        };
      }
      throw new Error(`Unexpected method ${method}`);
    });

    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          candidates: [candidate("openai-api-key", "openai/new", true)],
        },
      },
      client,
      firstRun: true,
    });
    expect(request).not.toHaveBeenCalled();
    await clickCandidate(page, "openai-api-key");
    await waitForFast(() => expect(resolveFirstActivation).toBeTypeOf("function"));

    publishGatewaySnapshot({
      ...context.gateway.snapshot,
      phase: "reconnecting",
      hello: null,
    });
    await page.updateComplete;
    publishGatewaySnapshot({
      ...snapshot,
      phase: "connected",
      hello: { ...snapshot.hello },
    });

    await waitForFast(() => {
      expect(page.textContent).toContain("previous activation is unresolved");
      expect(page.textContent).toContain("Check again");
    });
    expect(activationCount).toBe(1);
    expect(context.navigate).not.toHaveBeenCalled();

    await waitForFast(() =>
      expect(page.querySelector(".model-setup__recovery .btn")).not.toBeNull(),
    );
    const retry = page.querySelector<HTMLButtonElement>(".model-setup__recovery .btn")!;
    expect(retry.disabled).toBe(false);
    expect(
      JSON.parse(localStorage.getItem("openclaw.modelSetup.pendingActivation.v1")!).deadlineMs,
    ).toBeGreaterThan(Date.now());
    retry.click();
    await page.updateComplete;
    expect(activationCount).toBe(1);
    await waitForFast(() => expect(page.textContent).toContain("may still be running"));
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 500_000);
    retry.click();
    await waitForFast(() => expect(page.querySelector(".model-setup__loading")).toBeNull());
    expect(activationCount).toBe(1);
    await clickCandidate(page, "openai-api-key");

    await waitForFast(() => {
      expect(activationCount).toBe(2);
      expect(context.navigate).toHaveBeenCalledWith("custodian", { search: "?onboarding=1" });
    });
    resolveFirstActivation?.({
      done: true,
      status: "done",
      modelActivation: { modelRef: "openai/new", gatewayRestartRequired: true },
    });
  });

  it("rejects a different committed model before verification or another activation", async () => {
    const { context, client, request, snapshot, publishGatewaySnapshot } = createFirstRunContext();
    let resolveFirstActivation: ((result: WizardNextResult) => void) | undefined;
    let activationCount = 0;
    request.mockImplementation(async (method) => {
      if (method === "openclaw.setup.activate.start") {
        activationCount += 1;
        if (activationCount === 1) {
          return await new Promise<WizardNextResult>((resolve) => {
            resolveFirstActivation = resolve;
          });
        }
        return { done: true, status: "done", modelActivation: { modelRef: "openai/expected" } };
      }
      if (method === "openclaw.setup.detect") {
        return {
          ...detection,
          configuredModel: "anthropic/different",
          setupComplete: true,
          candidates: [candidate("openai-api-key", "openai/expected", true)],
        };
      }
      if (method === "openclaw.setup.verify") {
        return { ok: false, status: "auth", error: "The different model could not be verified" };
      }
      throw new Error(`Unexpected method ${method}`);
    });

    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          candidates: [candidate("openai-api-key", "openai/expected", true)],
        },
      },
      client,
      firstRun: true,
    });
    expect(request).not.toHaveBeenCalled();
    await clickCandidate(page, "openai-api-key");
    await waitForFast(() => expect(resolveFirstActivation).toBeTypeOf("function"));

    publishGatewaySnapshot({
      ...context.gateway.snapshot,
      phase: "reconnecting",
      hello: null,
    });
    await page.updateComplete;
    publishGatewaySnapshot({
      ...snapshot,
      phase: "connected",
      hello: { ...snapshot.hello },
    });

    await waitForFast(() => {
      expect(page.textContent).toContain("The model could not be activated");
      expect(page.textContent).toContain("openai/expected");
    });
    expect(
      request.mock.calls
        .map(([method]) => method)
        .filter((method) => method.startsWith("openclaw.setup.")),
    ).toEqual(["openclaw.setup.activate.start", "openclaw.setup.detect"]);
    expect(activationCount).toBe(1);
    expect(context.navigate).not.toHaveBeenCalled();
    resolveFirstActivation?.({
      done: true,
      status: "done",
      modelActivation: { modelRef: "openai/expected", gatewayRestartRequired: true },
    });
  });

  it("does not accept a different verified model after a required Gateway restart", async () => {
    const { context, client, request, snapshot, publishGatewaySnapshot } = createFirstRunContext();
    request.mockImplementation(async (method) => {
      if (method === "openclaw.setup.activate.start") {
        return {
          done: true,
          status: "done",
          modelActivation: { modelRef: "openai/expected", gatewayRestartRequired: true },
        };
      }
      if (method === "openclaw.setup.detect") {
        return { ...detection, configuredModel: "openai/different", setupComplete: true };
      }
      if (method === "openclaw.setup.verify") {
        return { ok: true, modelRef: "openai/different", latencyMs: 31 };
      }
      throw new Error(`Unexpected method ${method}`);
    });

    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          candidates: [candidate("openai-api-key", "openai/expected", true)],
        },
      },
      client,
      firstRun: true,
    });
    expect(request).not.toHaveBeenCalled();
    await clickCandidate(page, "openai-api-key");
    await waitForFast(() => expect(page.textContent).toContain("The Gateway is restarting"));

    publishGatewaySnapshot({
      ...context.gateway.snapshot,
      phase: "reconnecting",
      hello: null,
    });
    await page.updateComplete;
    publishGatewaySnapshot({
      ...snapshot,
      phase: "connected",
      hello: { ...snapshot.hello },
    });

    await waitForFast(() => {
      expect(page.textContent).toContain("The model could not be activated");
      expect(page.textContent).toContain("openai/expected");
    });
    expect(context.navigate).not.toHaveBeenCalled();
  });

  it("does not automatically verify or activate models from ordinary settings", async () => {
    const { context, client, request } = createFirstRunContext();

    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          configuredModel: "openai/existing",
          setupComplete: true,
          candidates: [candidate("anthropic-api-key", "anthropic/replacement", true)],
        },
      },
      client,
      firstRun: false,
    });

    expect(page.textContent).toContain("anthropic/replacement");
    expect(request).not.toHaveBeenCalled();
    expect(context.navigate).not.toHaveBeenCalled();
  });

  it("does not continue a stale first-run activation after leaving the onboarding route", async () => {
    const { context, client, request } = createFirstRunContext();
    const activation = createDeferred<WizardNextResult>();
    request.mockImplementation(async (method) => {
      if (method === "openclaw.setup.detect") {
        return detection;
      }
      if (method === "openclaw.setup.activate.start") {
        return activation.promise;
      }
      throw new Error(`Unexpected method ${method}`);
    });

    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          candidates: [
            candidate("openai-api-key", "openai/first", true),
            candidate("anthropic-api-key", "anthropic/second", true),
          ],
        },
      },
      client,
      firstRun: true,
    });
    expect(request).not.toHaveBeenCalled();
    await clickCandidate(page, "openai-api-key");
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());

    page.routeData = { firstRun: false };
    await page.updateComplete;
    activation.resolve({ done: true, status: "error", error: "The first login expired" });

    await waitForFast(() => expect(request.mock.settledResults[0]?.type).toBe("fulfilled"));
    await page.updateComplete;
    expect(page.textContent).not.toContain("The first login expired");
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "openclaw.setup.activate.start",
      "wizard.cancel",
      "openclaw.setup.detect",
      "openclaw.setup.detect",
    ]);
    expect(context.navigate).not.toHaveBeenCalled();
  });

  it("redetects before activating when a first-run visit replaces ordinary settings", async () => {
    const { context, client, request } = createFirstRunContext();
    request.mockImplementation(async (method, params) => {
      if (method === "openclaw.setup.detect") {
        return {
          ...detection,
          candidates: [candidate("anthropic-api-key", "anthropic/fresh", true)],
        };
      }
      if (method === "openclaw.setup.activate.start") {
        const parameters = requestParameters(params);
        if (!("modelRef" in parameters)) {
          throw new Error("Model activation is missing its model reference.");
        }
        return { done: true, status: "done", modelActivation: { modelRef: parameters.modelRef } };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          candidates: [candidate("openai-api-key", "openai/stale", true)],
        },
      },
      client,
      firstRun: false,
    });

    page.routeData = { firstRun: true };
    await page.updateComplete;
    await waitForFast(() => expect(page.textContent).toContain("anthropic/fresh"));
    expect(request.mock.calls.map(([method]) => method)).toEqual(["openclaw.setup.detect"]);
    await clickCandidate(page, "anthropic-api-key");

    await waitForFast(() => {
      expect(request.mock.calls.map(([method, params]) => [method, params])).toEqual([
        ["openclaw.setup.detect", { agentId: "main" }],
        [
          "openclaw.setup.activate.start",
          {
            sessionId: expect.any(String),
            agentId: "main",
            kind: "anthropic-api-key",
            modelRef: "anthropic/fresh",
          },
        ],
      ]);
    });
    await waitForFast(() =>
      expect(context.navigate).toHaveBeenCalledWith("custodian", { search: "?onboarding=1" }),
    );
  });
});
