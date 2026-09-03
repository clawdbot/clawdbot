/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import { i18n } from "../../i18n/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  clearFirstRunActivationReceipt,
  persistFirstRunActivationReceipt,
  readFirstRunActivationReceipt,
} from "./first-run-activation-receipt.ts";
import { FirstRunSetup } from "./first-run-setup.ts";
import {
  candidate,
  createFirstRunContext,
  detection,
  mountPage,
} from "./model-setup-first-run.test-support.ts";

describe("ModelSetupPage first-run activation ownership", () => {
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
  it("keeps first-run activation owned through an equivalent route-data refresh", async () => {
    const { context, client, request } = createFirstRunContext();
    const response = createDeferred<unknown>();
    request.mockImplementation(async (method) => {
      if (method === "openclaw.setup.detect") {
        return detection;
      }
      if (method === "openclaw.setup.activate.start") {
        return response.promise;
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          candidates: [candidate("openai-api-key", "provider/verified", true)],
        },
      },
      client,
      firstRun: true,
    });
    const success = {
      done: true,
      status: "done",
      modelActivation: { modelRef: "provider/verified" },
    };
    try {
      await waitForFast(() => expect(request).toHaveBeenCalledOnce());
      const receipt = localStorage.getItem("openclaw.modelSetup.pendingActivation.v1");
      page.routeData = { firstRun: true };
      await page.updateComplete;
      expect(request).toHaveBeenCalledOnce();
      expect(localStorage.getItem("openclaw.modelSetup.pendingActivation.v1")).toBe(receipt);
      response.resolve(success);
      await waitForFast(() =>
        expect(context.navigate).toHaveBeenCalledWith("custodian", { search: "?onboarding=1" }),
      );
      expect(request).toHaveBeenCalledOnce();
    } finally {
      response.resolve(success);
    }
  });

  it.each(["manual key", "provider sign-in"])(
    "requires an explicit current-model choice after losing a %s activation reply",
    async (entry) => {
      const { context, client, request, snapshot, publishGatewaySnapshot } =
        createFirstRunContext();
      let releaseActivation: ((value: unknown) => void) | undefined;
      const activatedMethod =
        entry === "manual key" ? "openclaw.setup.activate.start" : "wizard.next";
      request.mockImplementation(async (method) => {
        if (method === "openclaw.setup.auth.start") {
          return { sessionId: "auth", done: false, status: "running" };
        }
        if (method === activatedMethod) {
          return await new Promise((resolve) => {
            releaseActivation = resolve;
          });
        }
        if (method === "openclaw.setup.detect") {
          return { ...detection, configuredModel: "provider/current", setupComplete: true };
        }
        if (method === "openclaw.setup.verify") {
          return { ok: true, modelRef: "provider/current", latencyMs: 31 };
        }
        if (method === "wizard.cancel") {
          // This request crossed the commit point: cancellation is unconfirmed,
          // and the late activation response below can still report success.
          return { status: "running" };
        }
        throw new Error(`Unexpected method ${method}`);
      });
      const { page } = await mountPage(context, {
        state: {
          phase: "ready",
          result: {
            ...detection,
            manualProviders: [{ id: "provider-key", label: "Provider key" }],
            authOptions: [
              { id: "provider-login", label: "Provider login", kind: "oauth", featured: true },
            ],
          },
        },
        client,
        firstRun: true,
      });
      if (entry === "manual key") {
        const input = page.querySelector<HTMLInputElement>('input[type="password"]')!;
        input.value = "test-only-provider-key";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        page.querySelector<HTMLButtonElement>(".model-setup__manual .btn.primary")!.click();
      } else {
        page
          .querySelector<HTMLButtonElement>('[data-auth-choice="provider-login"] button')!
          .click();
      }
      await waitForFast(() => expect(releaseActivation).toBeTypeOf("function"));
      const receipt = localStorage.getItem("openclaw.modelSetup.pendingActivation.v1")!;
      expect(JSON.parse(receipt).modelRef).toBeNull();
      expect(receipt).not.toContain("test-only-provider-key");
      expect(receipt).not.toContain("provider-login");
      publishGatewaySnapshot({ ...snapshot, phase: "reconnecting", hello: null });
      await page.updateComplete;
      publishGatewaySnapshot({ ...snapshot, hello: { ...snapshot.hello } });
      await waitForFast(() => expect(page.textContent).toContain("Verify & use selected model"));
      expect(
        request.mock.calls.filter(([method]) => method === "openclaw.setup.verify"),
      ).toHaveLength(0);
      expect(context.navigate).not.toHaveBeenCalled();
      page.querySelector<HTMLButtonElement>(".model-setup__recovery .btn.primary")!.click();
      await waitForFast(() =>
        expect(context.navigate).toHaveBeenCalledWith("custodian", { search: "?onboarding=1" }),
      );
      releaseActivation?.({
        done: true,
        status: "done",
        modelActivation: { modelRef: "provider/late-other" },
      });
      await page.updateComplete;
      expect(request.mock.calls.filter(([method]) => method === activatedMethod)).toHaveLength(1);
      expect(context.navigate).toHaveBeenCalledOnce();
      expect(localStorage.getItem("openclaw.modelSetup.pendingActivation.v1")).toBeNull();
    },
  );

  it.each([
    ["auth", "terminal error"],
    ["prepare", "terminal error"],
    ["auth", "busy start"],
    ["prepare", "busy start"],
    ["auth", "busy next"],
    ["auth", "unknown start"],
    ["auth", "wrong-code start"],
    ["auth", "transport error"],
    ["auth", "RPC error"],
    ["auth", "retryable RPC error"],
    ["auth", "validation error"],
  ])("allows retry only after definitive %s %s", async (mode, outcome) => {
    const { context, client, request } = createFirstRunContext();
    const startMethod = `openclaw.setup.${mode}.start`;
    const selector = `[data-${mode === "auth" ? "auth" : "prepare"}-choice="provider-login"] button`;
    const failure = "Provider could not finish this sign-in";
    let nextCount = 0;
    let startCount = 0;
    request.mockImplementation(async (method) => {
      if (method === startMethod) {
        if (
          startCount++ === 0 &&
          ["busy start", "unknown start", "wrong-code start"].includes(outcome)
        ) {
          throw new GatewayRequestError({
            code: outcome === "wrong-code start" ? "INVALID_REQUEST" : "UNAVAILABLE",
            message: failure,
            ...(outcome !== "unknown start" ? { details: { code: "SETUP_ADMISSION_BUSY" } } : {}),
            retryable: true,
          });
        }
        return { done: false, status: "running" };
      }
      if (method === "wizard.next") {
        if (nextCount++ > 0 || startCount > 1) {
          return {
            done: false,
            status: "running",
            step: { id: "retry", type: "text", message: "Retry sign-in" },
          };
        }
        if (outcome === "transport error") {
          throw new Error(failure);
        }
        if (
          outcome === "RPC error" ||
          outcome === "retryable RPC error" ||
          outcome === "busy next"
        ) {
          throw new GatewayRequestError({
            code: "UNAVAILABLE",
            message: failure,
            retryable: outcome === "retryable RPC error",
            ...(outcome === "busy next" ? { details: { code: "SETUP_ADMISSION_BUSY" } } : {}),
          });
        }
        return outcome === "validation error"
          ? { done: false, status: "running", error: failure, step: { id: "login", type: "text" } }
          : { done: true, status: "error", error: failure };
      }
      if (method === "wizard.cancel") {
        if (outcome === "validation error") {
          return { status: "running" };
        }
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "wizard not found",
          details: { code: "WIZARD_NOT_FOUND" },
        });
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          authOptions: [{ id: "provider-login", label: "Provider", kind: "oauth", featured: true }],
          prepareOptions: [{ id: "provider-login", label: "Provider" }],
        },
      },
      client,
      firstRun: true,
    });
    const signIn = () => page.querySelector<HTMLButtonElement>(selector)!;
    signIn().click();
    await waitForFast(() => expect(page.textContent).toContain(failure));
    [...page.querySelectorAll<HTMLButtonElement>("openclaw-modal-dialog button")]
      .find(
        (button) =>
          button.textContent?.trim() === (outcome === "validation error" ? "Cancel" : "Close"),
      )!
      .click();
    await page.updateComplete;
    expect(page.querySelector("openclaw-modal-dialog")).toBeNull();
    const terminal = outcome === "terminal error" || outcome === "busy start";
    if (outcome === "busy start") {
      expect(request.mock.calls.map(([method]) => method)).toEqual([startMethod]);
    }
    expect(signIn().disabled).toBe(!terminal);
    expect(localStorage.getItem("openclaw.modelSetup.pendingActivation.v1") === null).toBe(
      terminal,
    );
    signIn().click();
    if (terminal) {
      await waitForFast(() => expect(page.textContent).toContain("Retry sign-in"));
    }
    expect(request.mock.calls.filter(([method]) => method === startMethod)).toHaveLength(
      terminal ? 2 : 1,
    );
    expect(request.mock.calls.some(([method]) => method === "openclaw.setup.verify")).toBe(false);
    expect(page.textContent).not.toContain("Connection verified");
    expect(context.navigate).not.toHaveBeenCalled();
  });

  it.each(
    ["same page", "new page", "new authenticated context"].flatMap((replacement) =>
      ["cancelled", "error", "busy"].map((terminal) => ({ replacement, terminal })),
    ),
  )(
    "does not clear a replacement sign-in after late $terminal ($replacement)",
    async ({ replacement, terminal }) => {
      const original = createFirstRunContext();
      const cancelled = createDeferred<unknown>();
      const result = {
        ...detection,
        authOptions: [
          { id: "provider-login", label: "Provider", kind: "oauth" as const, featured: true },
        ],
      };
      let startCount = 0;
      const respond = async (method: string) => {
        if (method === "openclaw.setup.auth.start") {
          if (terminal === "busy" && startCount++ === 0) {
            return await cancelled.promise;
          }
          return { done: false, status: "running" };
        }
        if (method === "wizard.next") {
          return {
            done: false,
            status: "running",
            step: { id: "login", type: "text", message: "Complete login" },
          };
        }
        if (method === "wizard.cancel") {
          if (terminal === "busy") {
            throw new Error("wizard not found");
          }
          return await cancelled.promise;
        }
        if (method === "openclaw.setup.detect") {
          return result;
        }
        throw new Error(`Unexpected method ${method}`);
      };
      original.request.mockImplementation(respond);
      let { page } = await mountPage(original.context, {
        state: { phase: "ready", result },
        client: original.client,
        firstRun: true,
      });
      const signIn = () =>
        page.querySelector<HTMLButtonElement>('[data-auth-choice="provider-login"] button')!;
      signIn().click();
      await waitForFast(() =>
        expect(original.request).toHaveBeenCalledWith(
          "openclaw.setup.auth.start",
          expect.anything(),
        ),
      );
      [...page.querySelectorAll<HTMLButtonElement>("openclaw-modal-dialog button")]
        .find((button) => button.textContent?.trim() === "Cancel")!
        .click();
      await waitForFast(() =>
        expect(original.request).toHaveBeenCalledWith("wizard.cancel", expect.anything()),
      );
      // Explicitly leaving first-run setup releases its intent. Re-entering is
      // a distinct attempt; the old cancellation acknowledgement is still pending.
      page.routeData = { ...page.routeData!, firstRun: false };
      await page.updateComplete;
      expect(localStorage.getItem("openclaw.modelSetup.pendingActivation.v1")).toBeNull();
      const next = replacement === "new authenticated context" ? createFirstRunContext() : original;
      if (next !== original) {
        next.context.gateway.connection.token = "replacement-test-auth";
        next.request.mockImplementation(respond);
      }
      if (replacement !== "same page") {
        page.remove();
        ({ page } = await mountPage(next.context, {
          state: { phase: "ready", result },
          client: next.client,
          firstRun: true,
        }));
      } else {
        page.routeData = { ...page.routeData!, firstRun: true };
        await page.updateComplete;
      }
      await waitForFast(() => expect(signIn()).not.toBeNull());
      signIn().click();
      await waitForFast(() => expect(page.textContent).toContain("Complete login"));
      const receipt = localStorage.getItem("openclaw.modelSetup.pendingActivation.v1");
      expect(receipt).not.toBeNull();
      if (terminal === "busy") {
        cancelled.reject(
          new GatewayRequestError({
            code: "UNAVAILABLE",
            message: "Setup busy",
            details: { code: "SETUP_ADMISSION_BUSY" },
          }),
        );
      } else {
        cancelled.resolve({ status: terminal });
      }
      await waitForFast(() =>
        expect(
          original.request.mock.settledResults.every((entry) => entry.type !== "incomplete"),
        ).toBe(true),
      );
      await page.updateComplete;
      expect(localStorage.getItem("openclaw.modelSetup.pendingActivation.v1")).toBe(receipt);
      expect(page.textContent).toContain("Complete login");
      expect(original.context.navigate).not.toHaveBeenCalled();
      expect(next.context.navigate).not.toHaveBeenCalled();
    },
  );

  it("retires an expired activation during synchronous receipt notification without reviving it", () => {
    const { context } = createFirstRunContext();
    const routeData = {
      firstRun: true,
      state: { phase: "ready" as const, result: detection },
      connection: {
        client: context.gateway.snapshot.client,
        hello: context.gateway.snapshot.hello,
        agentId: "main",
      },
    };
    const setup = new FirstRunSetup({
      context: () => context,
      routeData: () => routeData,
      pageState: () => routeData.state,
      actionsDisabled: () => false,
      canUseSetup: () => true,
      canVerify: () => true,
      verify: async () => undefined,
      activate: async () => undefined,
      setVerifyState: () => undefined,
      setActivationState: () => undefined,
      setRefreshWarning: () => undefined,
    });
    const notify = vi.fn();
    const unsubscribe = setup.subscribe(notify);
    try {
      const activation = setup.beginActivation({ kind: "provider-auth" });
      expect(activation).not.toBeNull();
      vi.spyOn(Date, "now").mockReturnValue(activation!.deadlineMs + 1);
      expect(() =>
        setup.recordActivation(activation, { ok: true, modelRef: "synthetic/model" }),
      ).not.toThrow();
      expect(notify).toHaveBeenCalledOnce();
      expect(setup.unresolved).toBe(false);
      expect(setup.ownsActivation(activation)).toBe(false);
      setup.finishActivation({ ok: true, modelRef: "synthetic/model" }, "provider-auth", null);
      expect(context.navigate).not.toHaveBeenCalled();
      expect(localStorage.getItem("openclaw.modelSetup.pendingActivation.v1")).toBeNull();
    } finally {
      unsubscribe();
      setup.dispose();
    }
  });

  const retirements = [
    "auth",
    "Gateway",
    "agent",
    "client",
    "hello",
    "route",
    "expiry",
    "removal",
    "replacement",
  ] as const;
  it.each(
    ["manual key", "provider sign-in"].flatMap((entry) =>
      ["reply", "refresh"].flatMap((boundary) =>
        retirements.map((changed) => ({ entry, boundary, changed })),
      ),
    ),
  )(
    "fences $entry success when $changed retires it during $boundary",
    async ({ entry, boundary, changed }) => {
      const reply = createDeferred<unknown>();
      const refreshing = createDeferred();
      const refresh = createDeferred();
      const { context, client, request } = createFirstRunContext(undefined, async () => {
        refreshing.resolve();
        await refresh.promise;
      });
      const activatedMethod =
        entry === "manual key" ? "openclaw.setup.activate.start" : "wizard.next";
      request.mockImplementation(async (method) => {
        if (method === "openclaw.setup.auth.start") {
          return { done: false, status: "running" };
        }
        if (method === activatedMethod) {
          return await reply.promise;
        }
        if (method === "openclaw.setup.detect") {
          return detection;
        }
        if (method === "wizard.cancel") {
          return { status: "running" };
        }
        throw new Error(`Unexpected method ${method}`);
      });
      const { page } = await mountPage(context, {
        state: {
          phase: "ready",
          result: {
            ...detection,
            manualProviders: [{ id: "provider", label: "Provider" }],
            authOptions: [
              { id: "provider-login", label: "Provider", kind: "oauth", featured: true },
            ],
          },
        },
        client,
        firstRun: true,
      });
      if (entry === "manual key") {
        const input = page.querySelector<HTMLInputElement>('input[type="password"]')!;
        input.value = "test-only-key";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        page.querySelector<HTMLButtonElement>(".model-setup__manual .btn.primary")!.click();
      } else {
        page
          .querySelector<HTMLButtonElement>('[data-auth-choice="provider-login"] button')!
          .click();
      }
      await waitForFast(() =>
        expect(request.mock.calls.some(([method]) => method === activatedMethod)).toBe(true),
      );
      const success = {
        done: true,
        status: "done",
        modelActivation: { modelRef: "provider/previous", latencyMs: 31 },
      };
      if (boundary === "refresh") {
        reply.resolve(success);
        await refreshing.promise;
      }
      if (changed === "auth") {
        context.gateway.connection.token = "replacement-auth";
      }
      if (changed === "Gateway") {
        context.gateway.connection.gatewayUrl = "ws://different.example";
      }
      if (changed === "agent") {
        context.agentSelection.state.selectedId = "research";
      }
      if (changed === "client") {
        const replacementClient = createFirstRunContext();
        replacementClient.request.mockResolvedValue(detection);
        context.gateway.snapshot.client = replacementClient.client;
      }
      if (changed === "hello") {
        context.gateway.snapshot.hello = { ...context.gateway.snapshot.hello! };
      }
      if (changed === "route") {
        page.routeData = { firstRun: false };
      }
      if (changed === "expiry") {
        const receipt = readFirstRunActivationReceipt(context)!;
        vi.spyOn(Date, "now").mockReturnValue(receipt.deadlineMs + 1);
      }
      if (changed === "removal") {
        clearFirstRunActivationReceipt();
      }
      const replacement =
        changed === "replacement"
          ? persistFirstRunActivationReceipt(
              {
                ...context,
                gateway: {
                  ...context.gateway,
                  connection: { ...context.gateway.connection, token: "replacement-auth" },
                },
              },
              { kind: "provider-auth", modelRef: "provider/replacement" },
            )
          : null;
      await page.updateComplete;
      reply.resolve(success);
      refresh.resolve();
      await waitForFast(() =>
        expect(context.runtimeConfig.runExternalMutation).toHaveResolvedWith(
          expect.objectContaining({ ok: true }),
        ),
      );
      await page.updateComplete;
      expect(page.textContent).not.toContain("Connection verified");
      expect(page.textContent).not.toContain("Cannot read properties");
      expect(page.querySelector("openclaw-modal-dialog")).toBeNull();
      expect(context.navigate).not.toHaveBeenCalled();
      if (replacement) {
        expect(localStorage.getItem("openclaw.modelSetup.pendingActivation.v1")).toBe(
          JSON.stringify(replacement),
        );
      }
    },
  );

  it.each(
    ["active", "replacement"].flatMap((ownership) =>
      ["result", "busy"].flatMap((rejection) =>
        ["candidate", "manual"].map((entry) => ({ ownership, rejection, entry })),
      ),
    ),
  )(
    "cleans up a definitive $rejection rejection without losing failure feedback or replacement ownership ($ownership, $entry)",
    async ({ ownership, rejection, entry }) => {
      const { context, client, request } = createFirstRunContext();
      const rejected = createDeferred<unknown>();
      request.mockReturnValue(rejected.promise);
      const { page } = await mountPage(context, {
        state: {
          phase: "ready",
          result: {
            ...detection,
            manualProviders: [{ id: "provider-key", label: "Provider key" }],
            candidates:
              entry === "manual"
                ? []
                : [
                    {
                      kind: "openai-api-key",
                      label: "Provider",
                      detail: "Available",
                      modelRef: "provider/model",
                      recommended: true,
                      credentials: true,
                    },
                  ],
          },
        },
        client,
        firstRun: true,
      });
      if (entry === "manual") {
        const input = page.querySelector<HTMLInputElement>('input[type="password"]')!;
        input.value = "test-only-provider-key";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        page.querySelector<HTMLButtonElement>(".model-setup__manual .btn.primary")!.click();
      }
      await waitForFast(() => expect(request).toHaveBeenCalledOnce());
      const replacement =
        ownership === "replacement"
          ? persistFirstRunActivationReceipt(
              {
                ...context,
                gateway: {
                  ...context.gateway,
                  connection: { ...context.gateway.connection, token: "replacement-auth" },
                },
              },
              { kind: "provider-auth", modelRef: "provider/replacement" },
            )
          : null;
      if (rejection === "busy") {
        rejected.reject(
          new GatewayRequestError({
            code: "UNAVAILABLE",
            message: "Provider rejected this test key",
            details: { code: "SETUP_ADMISSION_BUSY" },
          }),
        );
      } else {
        rejected.resolve({ done: true, status: "error", error: "Provider rejected this test key" });
      }
      await waitForFast(() =>
        expect(context.runtimeConfig.runExternalMutation).toHaveResolvedWith(
          expect.objectContaining({ ok: true }),
        ),
      );
      await page.updateComplete;
      if (ownership === "active") {
        expect(page.textContent).toContain("Provider rejected this test key");
      } else {
        expect(page.textContent).not.toContain("Provider rejected this test key");
      }
      expect(page.textContent).not.toContain("Cannot read properties");
      expect(page.textContent).not.toContain("Connection verified");
      expect(localStorage.getItem("openclaw.modelSetup.pendingActivation.v1")).toBe(
        replacement ? JSON.stringify(replacement) : null,
      );
      expect(context.navigate).not.toHaveBeenCalled();
      if (ownership === "active" && entry === "manual") {
        [...page.querySelectorAll<HTMLButtonElement>("openclaw-modal-dialog button")]
          .find((button) => button.textContent?.trim() === "Close")!
          .click();
        await page.updateComplete;
        const retry = page.querySelector<HTMLButtonElement>(".model-setup__manual .btn.primary")!;
        expect(retry.disabled).toBe(false);
        retry.click();
        await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
      }
    },
  );

  it.each([
    ["cancelled", "in place"],
    ["error", "in place"],
    ["error", "route refresh"],
    ["error", "reconnect"],
    ["error", "unmount"],
    ["busy", "in place"],
    ["busy", "route refresh"],
    ["busy", "reconnect"],
    ["busy", "unmount"],
    ["running", "in place"],
    ["cancelled", "route refresh"],
    ["cancelled", "reconnect"],
    ["cancelled", "unmount"],
    ["running", "unmount"],
    ["unknown", "unmount"],
    ["absent", "unmount"],
  ])(
    "only releases first-run intent after a confirmed negative terminal result (%s, %s)",
    async (cancelStatus, lifecycle) => {
      const { context, client, request, snapshot, publishGatewaySnapshot } =
        createFirstRunContext();
      const cancelled = createDeferred<unknown>();
      const result = {
        ...detection,
        authOptions: [
          { id: "provider-login", label: "Provider", kind: "oauth" as const, featured: true },
        ],
      };
      request.mockImplementation(async (method) => {
        if (method === "openclaw.setup.auth.start") {
          if (cancelStatus === "busy") {
            return await cancelled.promise;
          }
          return { sessionId: "auth", done: false, status: "running" };
        }
        if (method === "wizard.next") {
          return {
            done: false,
            status: "running",
            step: { id: "login", type: "text", message: "Complete login" },
          };
        }
        if (method === "wizard.cancel") {
          if (cancelStatus === "busy") {
            throw new Error("wizard not found");
          }
          return await cancelled.promise;
        }
        if (method === "openclaw.setup.detect") {
          return result;
        }
        throw new Error(`Unexpected method ${method}`);
      });
      let { page } = await mountPage(context, {
        state: { phase: "ready", result },
        client,
        firstRun: true,
      });
      page.querySelector<HTMLButtonElement>('[data-auth-choice="provider-login"] button')!.click();
      await waitForFast(() =>
        expect(request).toHaveBeenCalledWith("openclaw.setup.auth.start", expect.anything()),
      );
      const cancel = [
        ...page.querySelectorAll<HTMLButtonElement>("openclaw-modal-dialog button"),
      ].find((button) => button.textContent?.trim() === "Cancel")!;
      cancel.click();
      await waitForFast(() =>
        expect(request).toHaveBeenCalledWith("wizard.cancel", expect.anything()),
      );
      await page.updateComplete;
      expect(page.querySelector("openclaw-modal-dialog")).toBeNull();
      expect(localStorage.getItem("openclaw.modelSetup.pendingActivation.v1")).not.toBeNull();
      if (lifecycle === "route refresh") {
        page.routeData = { ...page.routeData! };
      } else if (lifecycle === "reconnect") {
        publishGatewaySnapshot({ ...snapshot, phase: "reconnecting", hello: null });
        await page.updateComplete;
        publishGatewaySnapshot({ ...snapshot, hello: { ...snapshot.hello } });
      } else if (lifecycle === "unmount") {
        page.remove();
      }
      await page.updateComplete;
      if (cancelStatus === "busy") {
        cancelled.reject(
          new GatewayRequestError({
            code: "UNAVAILABLE",
            message: "Setup busy",
            details: { code: "SETUP_ADMISSION_BUSY" },
          }),
        );
      } else if (cancelStatus === "absent") {
        cancelled.reject(new Error("wizard not found"));
      } else {
        cancelled.resolve(cancelStatus === "unknown" ? {} : { status: cancelStatus });
      }
      await waitForFast(() => {
        const cancelIndex = request.mock.calls.findIndex(
          ([method]) =>
            method === (cancelStatus === "busy" ? "openclaw.setup.auth.start" : "wizard.cancel"),
        );
        expect(request.mock.settledResults[cancelIndex]?.type).toBe(
          cancelStatus === "absent" || cancelStatus === "busy" ? "rejected" : "fulfilled",
        );
      });
      if (lifecycle === "unmount") {
        ({ page } = await mountPage(context, {
          state: { phase: "ready", result },
          client,
          firstRun: true,
        }));
      }
      await waitForFast(() => {
        const button = page.querySelector<HTMLButtonElement>(
          '[data-auth-choice="provider-login"] button',
        );
        expect(button).not.toBeNull();
        expect(button!.disabled).toBe(!["cancelled", "error", "busy"].includes(cancelStatus));
      });
      expect(localStorage.getItem("openclaw.modelSetup.pendingActivation.v1") === null).toBe(
        ["cancelled", "error", "busy"].includes(cancelStatus),
      );
      expect(context.navigate).not.toHaveBeenCalled();
    },
  );
});
