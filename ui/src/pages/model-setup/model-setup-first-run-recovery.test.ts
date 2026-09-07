/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { i18n } from "../../i18n/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  clearFirstRunActivationReceipt,
  readFirstRunActivationReceipt,
} from "./first-run-activation-receipt.ts";
import {
  candidate,
  clickCandidate,
  createFirstRunContext,
  detection,
  mountPage,
} from "./model-setup-first-run.test-support.ts";
import { MODEL_SETUP_VERIFY_TIMEOUT_MS } from "./state.ts";

describe("ModelSetupPage first-run application recovery", () => {
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

  it.each(["valid", "expiry", "removal", "auth"])(
    "accepts only a current restored verification after application recreation (%s)",
    async (receiptState) => {
      const original = createFirstRunContext();
      original.request.mockResolvedValue({
        done: true,
        status: "done",
        modelActivation: { modelRef: "openai/relaunch", gatewayRestartRequired: true },
      });
      const { page, provider } = await mountPage(original.context, {
        state: {
          phase: "ready",
          result: {
            ...detection,
            candidates: [candidate("openai-api-key", "openai/relaunch", true)],
          },
        },
        client: original.client,
        firstRun: true,
      });
      expect(original.request).not.toHaveBeenCalled();
      await clickCandidate(page, "openai-api-key");
      await waitForFast(() => expect(page.textContent).toContain("The Gateway is restarting"));
      provider.remove();

      const relaunched = createFirstRunContext();
      const verification = createDeferred<unknown>();
      relaunched.request.mockReturnValue(verification.promise);
      const { page: restored } = await mountPage(relaunched.context, {
        state: {
          phase: "ready",
          result: { ...detection, configuredModel: "openai/relaunch", setupComplete: true },
        },
        client: relaunched.client,
        firstRun: true,
      });

      await waitForFast(() => expect(relaunched.request).toHaveBeenCalledOnce());
      if (receiptState === "expiry") {
        const receipt = readFirstRunActivationReceipt(relaunched.context)!;
        vi.spyOn(Date, "now").mockReturnValue(receipt.deadlineMs + 1);
      } else if (receiptState === "removal") {
        clearFirstRunActivationReceipt();
      } else if (receiptState === "auth") {
        relaunched.context.gateway.connection.token = "replacement-auth";
      }
      verification.resolve({ ok: true, modelRef: "openai/relaunch", latencyMs: 31 });
      await waitForFast(() => expect(relaunched.request).toHaveResolved());
      await restored.updateComplete;
      if (receiptState === "valid") {
        expect(relaunched.context.navigate).toHaveBeenCalledWith("custodian", {
          search: "?onboarding=1",
        });
      } else {
        expect(relaunched.context.navigate).not.toHaveBeenCalled();
        expect(restored.querySelector(".model-setup__verified")).toBeNull();
        expect(restored.textContent).not.toContain("Continue setup");
        expect(restored.textContent).not.toContain("Cannot read properties");
      }
      expect(original.request).toHaveBeenCalledOnce();
      expect(relaunched.request).toHaveBeenCalledOnce();
      expect(relaunched.request).toHaveBeenCalledWith(
        "openclaw.setup.verify",
        { agentId: "main" },
        { timeoutMs: MODEL_SETUP_VERIFY_TIMEOUT_MS, signal: expect.any(AbortSignal) },
      );
    },
  );

  it("never repeats an ambiguous activation after app recreation until explicitly retried", async () => {
    const original = createFirstRunContext();
    original.request.mockResolvedValue({
      done: true,
      status: "done",
      modelActivation: { modelRef: "openai/relaunch", gatewayRestartRequired: true },
    });
    const { page: previous, provider } = await mountPage(original.context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          candidates: [candidate("openai-api-key", "openai/relaunch", true)],
        },
      },
      client: original.client,
      firstRun: true,
    });
    expect(original.request).not.toHaveBeenCalled();
    await clickCandidate(previous, "openai-api-key");
    await waitForFast(() => expect(previous.textContent).toContain("The Gateway is restarting"));
    provider.remove();

    const relaunched = createFirstRunContext();
    relaunched.request.mockImplementation(async (method) => {
      if (method === "openclaw.setup.detect") {
        return {
          ...detection,
          candidates: [candidate("openai-api-key", "openai/relaunch", true)],
        };
      }
      if (method === "openclaw.setup.activate.start") {
        return { done: true, status: "done", modelActivation: { modelRef: "openai/relaunch" } };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const { page } = await mountPage(relaunched.context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          candidates: [candidate("openai-api-key", "openai/relaunch", true)],
        },
      },
      client: relaunched.client,
      firstRun: true,
    });

    await waitForFast(() => {
      expect(page.textContent).toContain("previous activation is unresolved");
      expect(page.textContent).toContain("Check again");
    });
    expect(relaunched.request).not.toHaveBeenCalled();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 500_000);
    page.querySelector<HTMLButtonElement>(".model-setup__intro .btn")?.click();
    await waitForFast(() => expect(page.querySelector(".model-setup__loading")).toBeNull());
    expect(relaunched.request.mock.calls.map(([method]) => method)).toEqual([
      "openclaw.setup.detect",
    ]);
    await clickCandidate(page, "openai-api-key");

    await waitForFast(() => {
      expect(relaunched.request.mock.calls.map(([method]) => method)).toEqual([
        "openclaw.setup.detect",
        "openclaw.setup.activate.start",
      ]);
      expect(relaunched.context.navigate).toHaveBeenCalledWith("custodian", {
        search: "?onboarding=1",
      });
    });
    expect(original.request).toHaveBeenCalledOnce();
  });

  it("rejects a different committed model after full application recreation", async () => {
    const original = createFirstRunContext();
    original.request.mockResolvedValue({
      done: true,
      status: "done",
      modelActivation: { modelRef: "openai/expected", gatewayRestartRequired: true },
    });
    const { page: previous, provider } = await mountPage(original.context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          candidates: [candidate("openai-api-key", "openai/expected", true)],
        },
      },
      client: original.client,
      firstRun: true,
    });
    expect(original.request).not.toHaveBeenCalled();
    await clickCandidate(previous, "openai-api-key");
    await waitForFast(() => expect(previous.textContent).toContain("The Gateway is restarting"));
    provider.remove();

    const relaunched = createFirstRunContext();
    const { page } = await mountPage(relaunched.context, {
      state: {
        phase: "ready",
        result: { ...detection, configuredModel: "anthropic/different", setupComplete: true },
      },
      client: relaunched.client,
      firstRun: true,
    });

    await waitForFast(() => {
      expect(page.textContent).toContain("The model could not be activated");
      expect(page.textContent).toContain("openai/expected");
    });
    expect(relaunched.request).not.toHaveBeenCalled();
    expect(relaunched.context.navigate).not.toHaveBeenCalled();
  });

  it("never resumes another Gateway owner's activation after full application recreation", async () => {
    const original = createFirstRunContext();
    original.request.mockResolvedValue({
      done: true,
      status: "done",
      modelActivation: { modelRef: "openai/expected", gatewayRestartRequired: true },
    });
    const { page: previous, provider } = await mountPage(original.context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          candidates: [candidate("openai-api-key", "openai/expected", true)],
        },
      },
      client: original.client,
      firstRun: true,
    });
    expect(original.request).not.toHaveBeenCalled();
    await clickCandidate(previous, "openai-api-key");
    await waitForFast(() => expect(previous.textContent).toContain("The Gateway is restarting"));
    provider.remove();

    const relaunched = createFirstRunContext();
    relaunched.context.gateway.connection.token = "different-gateway-owner";
    relaunched.request.mockResolvedValue({ ok: true, modelRef: "openai/expected", latencyMs: 31 });
    await mountPage(relaunched.context, {
      state: {
        phase: "ready",
        result: { ...detection, configuredModel: "openai/expected", setupComplete: true },
      },
      client: relaunched.client,
      firstRun: true,
    });

    expect(relaunched.context.navigate).not.toHaveBeenCalled();
    expect(relaunched.request).not.toHaveBeenCalled();
  });
});
