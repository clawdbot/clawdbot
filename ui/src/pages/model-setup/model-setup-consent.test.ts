/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  candidate,
  createFirstRunContext,
  detection,
  mountPage,
} from "./model-setup-first-run.test-support.ts";

describe("ModelSetupPage activation consent", () => {
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

  it.each(["accept", "decline", "cancel"] as const)(
    "requires an explicit answer before activation (%s)",
    async (decision) => {
      const { context, client, request } = createFirstRunContext();
      const answers: unknown[] = [];
      let activeSession: string | undefined;
      request.mockImplementation(async (method, params) => {
        if (method === "openclaw.setup.activate.start") {
          activeSession = (params as { sessionId: string }).sessionId;
          return { sessionId: activeSession, done: false, status: "running" };
        }
        if (method === "wizard.next") {
          const next = params as {
            sessionId: string;
            answer?: { stepId: string; value?: unknown };
          };
          expect(next.sessionId).toBe(activeSession);
          if (!next.answer) {
            return {
              done: false,
              status: "running",
              step: {
                id: "review",
                type: "note",
                title: "Review model setup",
                message: "This changes the selected model route.",
              },
            };
          }
          answers.push(next.answer);
          if (next.answer.stepId === "review") {
            return {
              done: false,
              status: "running",
              step: {
                id: "consent",
                type: "confirm",
                title: "Confirm model setup",
                message: "Apply the reviewed changes?",
                initialValue: false,
              },
            };
          }
          return next.answer.value === true
            ? { done: true, status: "done", modelActivation: { modelRef: "provider/selected" } }
            : { done: true, status: "cancelled", error: "Model setup was declined." };
        }
        if (method === "wizard.cancel") {
          return { status: "cancelled" };
        }
        throw new Error(`Unexpected method ${method}`);
      });
      const { page } = await mountPage(context, {
        state: {
          phase: "ready",
          result: {
            ...detection,
            candidates: [
              candidate("codex-cli", "provider/selected", true),
              candidate("openai-api-key", "provider/other", true),
            ],
          },
        },
        client,
        firstRun: true,
      });
      await waitForFast(() => expect(page.textContent).toContain("Review model setup"));
      expect(context.navigate).not.toHaveBeenCalled();
      const button = (label: string) =>
        [...page.querySelectorAll<HTMLButtonElement>("openclaw-modal-dialog button")].find(
          (element) => element.textContent?.trim() === label,
        )!;
      button("Continue").click();
      await waitForFast(() => expect(page.textContent).toContain("Apply the reviewed changes?"));
      expect(answers).toEqual([{ stepId: "review", value: undefined }]);
      expect(context.navigate).not.toHaveBeenCalled();
      button(decision === "accept" ? "Yes" : decision === "decline" ? "No" : "Cancel").click();
      if (decision === "accept") {
        await waitForFast(() =>
          expect(context.navigate).toHaveBeenCalledWith("custodian", { search: "?onboarding=1" }),
        );
        expect(answers.at(-1)).toEqual({ stepId: "consent", value: true });
      } else {
        await waitForFast(() =>
          expect(localStorage.getItem("openclaw.modelSetup.pendingActivation.v1")).toBeNull(),
        );
        expect(context.navigate).not.toHaveBeenCalled();
        if (decision === "decline") {
          expect(answers.at(-1)).toEqual({ stepId: "consent", value: false });
        } else {
          expect(request).toHaveBeenCalledWith("wizard.cancel", { sessionId: activeSession });
        }
      }
      expect(
        request.mock.calls.filter(([method]) => method === "openclaw.setup.activate.start"),
      ).toHaveLength(1);
      expect(request.mock.calls.some(([method]) => method === "openclaw.setup.activate")).toBe(
        false,
      );
    },
  );
});
