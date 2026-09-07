/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayHelloOk } from "../../api/gateway.ts";
import type { WizardNextResult } from "../../api/types.ts";
import { createGatewayStoreTestStore } from "../../app/gateway-store.test-support.ts";
import { loadSettings } from "../../app/settings.ts";
import { i18n } from "../../i18n/index.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { persistFirstRunActivationReceipt } from "./first-run-activation-receipt.ts";
import { createFirstRunContext, detection } from "./model-setup-first-run.test-support.ts";
import { ModelSetupPage } from "./model-setup-page.ts";

describe("first-run wizard ownership through the real Gateway store", () => {
  beforeEach(async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    localStorage.setItem(
      "openclaw-device-identity-v1",
      JSON.stringify({ version: 1, privateKey: "synthetic-gateway-owner-device-key" }),
    );
    await i18n.setLocale("en");
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const ownerChanges = [
    "same target",
    "token change",
    "admin access lost",
    "same-client admin access lost",
    "authenticated owner change",
    "same-client authenticated owner change",
    "authenticated scope missing",
    "authenticated scope missing from start",
    "authenticated owner change with another receipt",
  ] as const;

  it.each(ownerChanges)(
    "%s preserves or retires the clicked receipt without replay",
    async (change) => {
      const { gateway, current } = createGatewayStoreTestStore({
        settings: {
          ...loadSettings(),
          gatewayUrl: "wss://synthetic-gateway.example.test",
          token: "synthetic-initial-token",
        },
      });
      const hello = (recoveryScope = "synthetic-owner-a"): GatewayHelloOk => ({
        type: "hello-ok",
        protocol: 1,
        auth: {
          role: "operator",
          scopes: ["operator.read", "operator.admin"],
          deviceToken: "synthetic-device-grant",
          recoveryScope,
        },
        features: {
          methods: [
            "config.get",
            "config.set",
            "openclaw.setup.detect",
            "openclaw.setup.auth.start",
            "openclaw.setup.verify",
            "wizard.next",
            "wizard.cancel",
          ],
        },
      });
      const originalAnswer = createDeferred<WizardNextResult>();
      const answerStarted = createDeferred();
      const inventory = {
        ...detection,
        authOptions: [
          {
            id: "selected-provider",
            label: "Selected provider",
            kind: "oauth" as const,
            featured: true,
          },
        ],
      };
      gateway.start();
      const original = current();
      const sharedResponse = (method: string) => {
        if (method === "openclaw.setup.detect") {
          return inventory;
        }
        if (method === "config.get") {
          return {
            config: {},
            sourceConfig: {},
            raw: "{}",
            hash: "synthetic-config",
            valid: true,
            issues: [],
          };
        }
        if (method === "wizard.cancel") {
          return { status: "cancelled" };
        }
        throw new Error(`Unexpected fixture request: ${method}`);
      };
      original.request.mockImplementation(async (method, params) => {
        if (method === "openclaw.setup.auth.start") {
          return { done: false, status: "running" };
        }
        if (method === "wizard.next") {
          if ((params as { answer?: unknown }).answer) {
            answerStarted.resolve();
            return await originalAnswer.promise;
          }
          return {
            done: false,
            status: "running",
            step: {
              id: "provider-key",
              type: "text",
              message: "Enter selected provider key",
              sensitive: true,
            },
          };
        }
        return sharedResponse(method);
      });
      const initialHello = hello();
      if (change === "authenticated scope missing from start") {
        delete initialHello.auth!.recoveryScope;
      }
      original.opts.onHello?.(initialHello);
      const runtimeConfig = createRuntimeConfigCapability(gateway);
      const fixture = createFirstRunContext();
      const context = { ...fixture.context, gateway, runtimeConfig };
      const provider = createApplicationContextProvider(context);
      const page = new ModelSetupPage();
      page.routeData = { firstRun: true };
      provider.append(page);
      document.body.append(provider);
      try {
        await waitForFast(() =>
          expect(
            page.querySelector('[data-auth-choice="selected-provider"] button'),
          ).not.toBeNull(),
        );
        page
          .querySelector<HTMLButtonElement>('[data-auth-choice="selected-provider"] button')!
          .click();
        await waitForFast(() =>
          expect(page.querySelector("#model-setup-wizard-text-input")).not.toBeNull(),
        );
        const input = page.querySelector<HTMLInputElement>("#model-setup-wizard-text-input")!;
        input.value = "synthetic-provider-key";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await page.updateComplete;
        page
          .querySelector<HTMLFormElement>("openclaw-modal-dialog form")!
          .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        await answerStarted.promise;
        const receipt = localStorage.getItem("openclaw.modelSetup.pendingActivation.v1");
        expect(receipt).not.toBeNull();
        const originalRevision = gateway.connectionRevision;
        const originalStart = original.request.mock.calls.find(
          ([method]) => method === "openclaw.setup.auth.start",
        )!;
        const sessionId = (originalStart[1] as { sessionId: string }).sessionId;

        let replacementReceipt: string | null = null;
        if (change === "authenticated owner change with another receipt") {
          persistFirstRunActivationReceipt(context, {
            kind: "provider-auth",
            modelRef: "provider/another-choice",
          });
          replacementReceipt = localStorage.getItem("openclaw.modelSetup.pendingActivation.v1");
          expect(replacementReceipt).not.toBe(receipt);
        }
        // Exercise both actual client replacement and the store's socket-close
        // callback; neither path fabricates revision or snapshot state.
        if (change.startsWith("same-client")) {
          original.opts.onClose?.({ code: 1006, reason: "synthetic reconnect", willRetry: true });
        } else {
          gateway.connect(
            change === "token change" ? { token: "synthetic-replacement-token" } : {},
          );
        }
        const replacement = current();
        const requestOffset = replacement.request.mock.calls.length;
        const replacementRequests = () => replacement.request.mock.calls.slice(requestOffset);
        replacement.request.mockImplementation(async (method) => {
          if (method === "wizard.next") {
            return {
              done: false,
              status: "running",
              step: { id: "provider-review", type: "note", message: "Review selected provider" },
            };
          }
          return sharedResponse(method);
        });
        const reconnectedHello = hello(
          change.includes("authenticated owner change") ? "synthetic-owner-b" : undefined,
        );
        if (change.startsWith("authenticated scope missing")) {
          delete reconnectedHello.auth!.recoveryScope;
        }
        const authorityLost = change.includes("admin access lost");
        if (authorityLost) {
          reconnectedHello.auth!.scopes = ["operator.read"];
          replacementReceipt = receipt;
        }
        replacement.opts.onHello?.(reconnectedHello);
        expect(gateway.connectionRevision).toBe(
          originalRevision + (change === "token change" ? 1 : 0),
        );

        if (change === "same target") {
          await waitForFast(() => expect(page.textContent).toContain("Review selected provider"));
          expect(localStorage.getItem("openclaw.modelSetup.pendingActivation.v1")).toBe(receipt);
          expect(
            replacementRequests()
              .filter(([method]) => method === "wizard.next")
              .map(([, params]) => params),
          ).toEqual([{ sessionId }]);
          expect(
            original.request.mock.calls.filter(([method]) => method === "wizard.cancel"),
          ).toHaveLength(0);
        } else {
          await waitForFast(() => expect(page.querySelector("openclaw-modal-dialog")).toBeNull());
          expect(
            replacementRequests().filter(([method]) => method.startsWith("wizard.")),
          ).toHaveLength(0);
          expect(localStorage.getItem("openclaw.modelSetup.pendingActivation.v1")).toBe(
            replacementReceipt,
          );
          if (authorityLost) {
            expect(page.textContent).toContain("operator.admin");
            expect(
              replacementRequests().filter(([method]) => method.startsWith("openclaw.setup.")),
            ).toHaveLength(0);
          }
        }
        originalAnswer.resolve({
          done: true,
          status: "done",
          modelActivation: { modelRef: "provider/original" },
        });
        await waitForFast(() =>
          expect(
            original.request.mock.settledResults.filter((result) => result.type === "incomplete"),
          ).toHaveLength(0),
        );
        if (authorityLost) {
          // Reauthorizing the same principal restores discovery, not a discarded
          // wizard handle or permission to replay its prior answer.
          replacement.opts.onHello?.(hello());
          await waitForFast(() =>
            expect(page.querySelector(".model-setup__recovery")).not.toBeNull(),
          );
          expect(page.querySelector("openclaw-modal-dialog")).toBeNull();
          expect(
            replacementRequests().filter(([method]) => method.startsWith("wizard.")),
          ).toHaveLength(0);
        }
        if (change !== "same target") {
          expect(localStorage.getItem("openclaw.modelSetup.pendingActivation.v1")).toBe(
            replacementReceipt,
          );
        }
        expect(context.navigate).not.toHaveBeenCalled();
        expect(
          original.request.mock.calls.filter(([method]) => method === "openclaw.setup.auth.start"),
        ).toHaveLength(1);
        expect(
          replacementRequests().filter(([method]) => method === "openclaw.setup.auth.start"),
        ).toHaveLength(0);
        expect(
          original.request.mock.calls.filter(
            ([method, params]) =>
              method === "wizard.next" && Boolean((params as { answer?: unknown }).answer),
          ),
        ).toHaveLength(1);
      } finally {
        originalAnswer.resolve({ done: true, status: "cancelled" });
        page.remove();
        runtimeConfig.dispose();
        fixture.context.runtimeConfig.dispose();
        gateway.stop();
      }
    },
  );
});
