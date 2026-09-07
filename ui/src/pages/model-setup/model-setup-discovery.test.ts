/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WizardNextParams } from "../../../../packages/gateway-protocol/src/schema/wizard.ts";
import { WizardSession } from "../../../../src/wizard/session.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import { i18n } from "../../i18n/index.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  candidate,
  clickCandidate,
  createFirstRunContext,
  detection,
  mountPage,
  selectManualProvider,
} from "./model-setup-first-run.test-support.ts";
import { ModelSetupPage } from "./model-setup-page.ts";

describe("Model Setup explicit discovery", () => {
  beforeEach(async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    localStorage.setItem(
      "openclaw-device-identity-v1",
      JSON.stringify({ version: 1, privateKey: "test-device-key" }),
    );
    await i18n.setLocale("en");
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("detects an existing first-run route without testing it until a click", async () => {
    const { context, request } = createFirstRunContext();
    request.mockImplementation(async (method) => {
      if (method === "openclaw.setup.detect") {
        return { ...detection, configuredModel: "openai/existing", setupComplete: true };
      }
      if (method === "openclaw.setup.verify") {
        return { ok: true, modelRef: "openai/existing", latencyMs: 12 };
      }
      throw new Error(`Unexpected setup request: ${method}`);
    });
    const provider = createApplicationContextProvider(context);
    const page = new ModelSetupPage();
    page.routeData = { firstRun: true };
    provider.append(page);
    document.body.append(provider);
    await waitForFast(() =>
      expect(page.querySelector(".model-setup__current button")).not.toBeNull(),
    );
    await page.updateComplete;
    expect(request.mock.calls.map(([method]) => method)).toEqual(["openclaw.setup.detect"]);
    expect(context.navigate).not.toHaveBeenCalled();
    expect(localStorage.getItem("openclaw.modelSetup.pendingActivation.v1")).toBeNull();
    page.querySelector<HTMLButtonElement>(".model-setup__current button")!.click();
    await waitForFast(() => expect(page.querySelector(".model-setup__verified")).not.toBeNull());
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "openclaw.setup.detect",
      "openclaw.setup.verify",
    ]);
  });

  it.each(["cancel at credentials", "finish final commit"] as const)(
    "retains the admitted wizard after protected cancellation: %s",
    async (outcome) => {
      const { context, client, request } = createFirstRunContext();
      const installed = createDeferred();
      const allowInstall = createDeferred();
      const committed = createDeferred();
      const allowCommit = createDeferred();
      const terminal = createDeferred();
      const answers: unknown[] = [];
      let session: WizardSession | undefined;
      let sessionId: string | undefined;
      let starts = 0;
      request.mockImplementation(async (method, params) => {
        if (method === "openclaw.setup.activate.start") {
          starts += 1;
          sessionId = (params as { sessionId: string }).sessionId;
          session = new WizardSession(async (prompter, _signal, owner) => {
            try {
              await prompter.confirm({ message: "Install provider?", initialValue: false });
              owner.lockCancellationForPreparation();
              installed.resolve();
              await allowInstall.promise;
              await prompter.text({ message: "Provider API key", sensitive: true });
              owner.finishPreparation();
              owner.lockCancellation();
              committed.resolve();
              await allowCommit.promise;
              owner.setModelActivation({ modelRef: "openai/selected" });
            } finally {
              terminal.resolve();
            }
          });
          return { done: false, status: "running" };
        }
        if (method === "wizard.next") {
          const next = params as WizardNextParams;
          expect(next.sessionId).toBe(sessionId);
          if (next.answer) {
            answers.push(next.answer.value);
            await session!.answer(next.answer.stepId, next.answer.value);
          }
          return await session!.next();
        }
        if (method === "wizard.cancel") {
          expect(params).toEqual({ sessionId });
          session!.cancel();
          return { status: session!.getStatus(), error: session!.getError() };
        }
        if (method === "openclaw.setup.detect") {
          return { ...detection, configuredModel: "openai/selected", setupComplete: true };
        }
        if (method === "openclaw.setup.verify") {
          return { ok: true, modelRef: "openai/selected", latencyMs: 12 };
        }
        throw new Error(`Unexpected setup request: ${method}`);
      });
      const { page } = await mountPage(context, {
        client,
        firstRun: true,
        state: {
          phase: "ready",
          result: {
            ...detection,
            candidates: [candidate("openai-api-key", "openai/selected", true)],
          },
        },
      });
      const cancel = () =>
        page.querySelector("openclaw-modal-dialog")!.dispatchEvent(new CustomEvent("modal-cancel"));
      try {
        await clickCandidate(page, "openai-api-key");
        await waitForFast(() => expect(page.textContent).toContain("Install provider?"));
        const confirm = [
          ...page.querySelectorAll<HTMLButtonElement>("openclaw-modal-dialog button"),
        ].find((button) => button.textContent?.trim() === "Yes")!;
        confirm.click();
        await installed.promise;
        cancel();
        await waitForFast(() =>
          expect(page.textContent).toContain("Setup is finishing the current step"),
        );
        expect(page.querySelector("openclaw-modal-dialog")).not.toBeNull();
        expect(localStorage.getItem("openclaw.modelSetup.pendingActivation.v1")).not.toBeNull();
        expect(session!.getStatus()).toBe("running");
        expect(answers).toEqual([true]);
        expect(starts).toBe(1);
        allowInstall.resolve();
        await waitForFast(() => expect(page.textContent).toContain("Provider API key"));
        if (outcome === "cancel at credentials") {
          cancel();
          await terminal.promise;
          await waitForFast(() =>
            expect(localStorage.getItem("openclaw.modelSetup.pendingActivation.v1")).toBeNull(),
          );
          expect(session!.getStatus()).toBe("cancelled");
          expect(answers).toEqual([true]);
        } else {
          const input = page.querySelector<HTMLInputElement>(
            'openclaw-modal-dialog input[type="password"]',
          )!;
          input.value = "synthetic-key";
          input.dispatchEvent(new Event("input", { bubbles: true }));
          await page.updateComplete;
          page
            .querySelector<HTMLFormElement>("openclaw-modal-dialog form")!
            .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
          await committed.promise;
          cancel();
          await waitForFast(() =>
            expect(page.textContent).toContain("Setup is finishing the current step"),
          );
          expect(session!.getStatus()).toBe("running");
          allowCommit.resolve();
          await terminal.promise;
          await waitForFast(() => expect(page.textContent).toContain("Connection verified"));
          expect(answers).toEqual([true, "synthetic-key"]);
        }
        expect(starts).toBe(1);
      } finally {
        allowInstall.resolve();
        allowCommit.resolve();
        session?.close(new Error("test cleanup"));
        if (session) {
          await terminal.promise;
        }
      }
    },
  );

  it.each(["network", "denied", "missing wizard"] as const)(
    "shows an explicit cancellation %s failure without discarding the clicked receipt",
    async (failure) => {
      const { context, client, request } = createFirstRunContext();
      let cancels = 0;
      const error =
        failure === "missing wizard"
          ? new GatewayRequestError({
              code: "INVALID_REQUEST",
              message: "wizard not found",
              details: { code: "WIZARD_NOT_FOUND" },
            })
          : failure === "denied"
            ? new GatewayRequestError({ code: "FORBIDDEN", message: "Cancel permission denied" })
            : new Error("Cancellation transport failed");
      request.mockImplementation(async (method) => {
        if (method === "openclaw.setup.activate.start") {
          return { done: false, status: "running" };
        }
        if (method === "wizard.next") {
          return {
            done: false,
            status: "running",
            step: {
              id: "credential",
              type: "text",
              message: "Provider credential",
              sensitive: true,
              executor: "client",
            },
          };
        }
        if (method === "wizard.cancel") {
          if (++cancels === 1) {
            throw error;
          }
          return { status: "cancelled" };
        }
        throw new Error(`Unexpected setup request: ${method}`);
      });
      const { page } = await mountPage(context, {
        client,
        firstRun: true,
        state: {
          phase: "ready",
          result: {
            ...detection,
            candidates: [candidate("openai-api-key", "openai/selected", true)],
          },
        },
      });
      await clickCandidate(page, "openai-api-key");
      await waitForFast(() => expect(page.textContent).toContain("Provider credential"));
      const receiptKey = "openclaw.modelSetup.pendingActivation.v1";
      const receipt = localStorage.getItem(receiptKey);
      expect(receipt).not.toBeNull();
      const cancel = () =>
        page.querySelector("openclaw-modal-dialog")!.dispatchEvent(new CustomEvent("modal-cancel"));
      cancel();
      if (failure === "missing wizard") {
        await waitForFast(() => expect(page.textContent).toContain("It may already have finished"));
        expect(cancels).toBe(1);
        expect(localStorage.getItem(receiptKey)).toBe(receipt);
        const close = [
          ...page.querySelectorAll<HTMLButtonElement>("openclaw-modal-dialog button"),
        ].find((button) => button.textContent?.trim() === "Close");
        expect(close).toBeDefined();
        close!.click();
        await waitForFast(() => expect(page.querySelector("openclaw-modal-dialog")).toBeNull());
        expect(page.querySelector(".model-setup__recovery")).not.toBeNull();
        expect(localStorage.getItem(receiptKey)).toBe(receipt);
      } else {
        await waitForFast(() =>
          expect(page.querySelector(".model-setup-wizard .callout.warning")?.textContent).toContain(
            "Could not confirm cancellation",
          ),
        );
        expect(page.textContent).toContain(error.message);
        expect(page.textContent).toContain("Provider credential");
        expect(localStorage.getItem(receiptKey)).toBe(receipt);
        expect(cancels).toBe(1);
        cancel();
        await waitForFast(() => expect(page.querySelector("openclaw-modal-dialog")).toBeNull());
        expect(localStorage.getItem(receiptKey)).toBeNull();
        expect(cancels).toBe(2);
      }
      expect(
        request.mock.calls.filter(([method]) => method === "openclaw.setup.activate.start"),
      ).toHaveLength(1);
      expect(context.navigate).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "sends only an explicit fresh-install discovery choice (%s)",
    async (enabled) => {
      const { context, client, request } = createFirstRunContext();
      request.mockResolvedValue({ done: true, status: "cancelled" });
      const { page } = await mountPage(context, {
        client,
        firstRun: true,
        state: {
          phase: "ready",
          result: {
            ...detection,
            nativeSessionCatalogPreferenceRequired: true,
            nativeSessionCatalogs: [
              { pluginId: "anthropic", label: "Claude" },
              { pluginId: "codex", label: "Codex" },
            ],
            candidates: [candidate("codex-cli", "openai/available", true)],
            manualProviders: [{ id: "api-key", label: "API provider" }],
          },
        },
      });
      const checkbox = page.querySelector<HTMLInputElement>(
        ".model-setup__native-discovery input",
      )!;
      expect(checkbox.checked).toBe(false);
      expect(page.querySelector("[data-selected]")).toBeNull();
      expect(request).not.toHaveBeenCalled();
      expect(localStorage.getItem("openclaw.modelSetup.pendingActivation.v1")).toBeNull();
      if (enabled) {
        checkbox.click();
        await page.updateComplete;
      }
      expect(request).not.toHaveBeenCalled();
      await clickCandidate(page, "codex-cli");
      await waitForFast(() => expect(request).toHaveBeenCalledOnce());
      expect(request.mock.calls[0]).toEqual([
        "openclaw.setup.activate.start",
        expect.objectContaining({
          kind: "codex-cli",
          modelRef: "openai/available",
          nativeSessionCatalogsEnabled: enabled,
        }),
        { timeoutMs: null },
      ]);
    },
  );

  it.each(["install", "custom"] as const)(
    "offers %s choices without installing or starting auth on discovery",
    async (kind) => {
      const { context, client, request } = createFirstRunContext();
      request.mockResolvedValue({ done: true, status: "cancelled" });
      const { page } = await mountPage(context, {
        client,
        firstRun: true,
        state: {
          phase: "ready",
          result: {
            ...detection,
            nativeSessionCatalogPreferenceRequired: true,
            nativeSessionCatalogs: [{ pluginId: "catalog-plugin", label: "Native conversations" }],
            authOptions: [
              {
                id: "manifest-auth",
                label: kind === "install" ? "Meta" : "Compatible endpoint",
                kind,
                featured: false,
              },
            ],
          },
        },
      });
      expect(request).not.toHaveBeenCalled();
      const button = page.querySelector<HTMLButtonElement>(
        '[data-auth-choice="manifest-auth"] button',
      )!;
      expect(button.closest("details")).toBeNull();
      expect(button.textContent).toContain(
        kind === "install" ? "Review & install" : "Set up endpoint",
      );
      button.click();
      await waitForFast(() => expect(request).toHaveBeenCalledOnce());
      expect(request.mock.calls[0]).toEqual([
        "openclaw.setup.auth.start",
        expect.objectContaining({
          authChoice: "manifest-auth",
          nativeSessionCatalogsEnabled: false,
        }),
        { timeoutMs: null },
      ]);
    },
  );

  it("does not change upgrade catalog choices or select a manual provider implicitly", async () => {
    const { context, client, request } = createFirstRunContext();
    request.mockResolvedValue({ done: true, status: "cancelled" });
    const { page } = await mountPage(context, {
      client,
      firstRun: true,
      state: {
        phase: "ready",
        result: {
          ...detection,
          configuredModel: "openai/existing",
          setupComplete: true,
          nativeSessionCatalogPreferenceRequired: false,
          nativeSessionCatalogs: [{ pluginId: "codex", label: "Codex" }],
          manualProviders: [{ id: "provider-key", label: "API provider" }],
        },
      },
    });
    expect(request).not.toHaveBeenCalled();
    expect(page.querySelector(".model-setup__native-discovery")).toBeNull();
    expect(page.querySelector("[data-selected]")).toBeNull();
    await selectManualProvider(page, "provider-key");
    const input = page.querySelector<HTMLInputElement>(".model-setup__manual input")!;
    input.value = "test-only-key";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    page.querySelector<HTMLButtonElement>(".model-setup__manual .btn.primary")!.click();
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    expect(request.mock.calls[0]![1]).not.toHaveProperty("nativeSessionCatalogsEnabled");
  });
  it("clears a pending credential and native discovery opt-in when the Gateway identity changes", async () => {
    const { context, client, request, snapshot, publishGatewaySnapshot } = createFirstRunContext();
    const fresh = {
      ...detection,
      nativeSessionCatalogPreferenceRequired: true,
      nativeSessionCatalogs: [{ pluginId: "codex", label: "Codex" }],
      manualProviders: [{ id: "provider-key", label: "API provider" }],
    };
    request.mockResolvedValue(fresh);
    const { page } = await mountPage(context, {
      client,
      firstRun: true,
      state: { phase: "ready", result: fresh },
    });
    page.querySelector<HTMLInputElement>(".model-setup__native-discovery input")!.click();
    await selectManualProvider(page, "provider-key");
    const input = page.querySelector<HTMLInputElement>(".model-setup__manual input")!;
    input.value = "test-only-pending-key";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await page.updateComplete;
    expect(request).not.toHaveBeenCalled();
    Object.assign(context.gateway, { connectionRevision: context.gateway.connectionRevision + 1 });
    publishGatewaySnapshot({ ...snapshot });
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith(
        "openclaw.setup.detect",
        { agentId: "main" },
        expect.objectContaining({ timeoutMs: expect.any(Number), signal: expect.any(AbortSignal) }),
      ),
    );
    await waitForFast(() =>
      expect(page.querySelector(".model-setup__native-discovery input")).not.toBeNull(),
    );
    expect(
      page.querySelector<HTMLInputElement>(".model-setup__native-discovery input")!.checked,
    ).toBe(false);
    expect(page.querySelector<HTMLInputElement>(".model-setup__manual input")!.value).toBe("");
    expect(page.querySelector("[data-selected]")).toBeNull();
    expect(request.mock.calls.map(([method]) => method)).toEqual(["openclaw.setup.detect"]);
  });

  it.each(["same client", "replacement client"])(
    "keeps explicit discovery opt-in across a same-Gateway reconnect (%s)",
    async (replacement) => {
      const { context, client, request, snapshot, publishGatewaySnapshot } =
        createFirstRunContext();
      const fresh = {
        ...detection,
        nativeSessionCatalogPreferenceRequired: true,
        nativeSessionCatalogs: [{ pluginId: "codex", label: "Codex" }],
      };
      request.mockResolvedValue(fresh);
      const { page } = await mountPage(context, {
        client,
        firstRun: true,
        state: { phase: "ready", result: fresh },
      });
      page.querySelector<HTMLInputElement>(".model-setup__native-discovery input")!.click();
      await page.updateComplete;
      publishGatewaySnapshot({ ...snapshot, phase: "reconnecting", hello: null });
      await page.updateComplete;
      publishGatewaySnapshot({
        ...snapshot,
        client: replacement === "same client" ? client : createTestGatewayClient(request),
        hello: { ...snapshot.hello },
      });
      await waitForFast(() =>
        expect(page.querySelector(".model-setup__native-discovery input")).not.toBeNull(),
      );
      expect(
        page.querySelector<HTMLInputElement>(".model-setup__native-discovery input")!.checked,
      ).toBe(true);
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "config.get",
        "openclaw.setup.detect",
      ]);
    },
  );
});
