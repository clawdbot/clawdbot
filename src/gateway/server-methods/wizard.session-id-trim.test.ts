import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  runWithGatewayIndependentRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import { createWizardSessionTracker } from "../server-wizard-sessions.js";
import { whenAdmittedWizardSessionSettled } from "./setup-admission.js";
import { wizardHandlers } from "./wizard.js";

afterEach(() => {
  resetGatewayWorkAdmission();
});

describe("wizard.cancel padded sessionId", () => {
  it("cancels a live wizard when sessionId has surrounding whitespace", async () => {
    const runnerSettled = createDeferred();
    const tracker = createWizardSessionTracker();
    const context = {
      ...tracker,
      wizardRunner: async (_opts: unknown, _runtime: RuntimeEnv, prompter: WizardPrompter) => {
        prompter.progress("working");
        await runnerSettled.promise;
      },
    };

    let sessionId = "";
    await runWithGatewayIndependentRootWorkAdmission(async () => {
      const respond = vi.fn();
      await wizardHandlers["wizard.start"]!({
        params: { mode: "local" },
        respond,
        context,
      } as never);
      sessionId = String(respond.mock.calls[0]?.[1]?.sessionId ?? "");
    });
    expect(sessionId).not.toBe("");
    expect(tracker.wizardSessions.has(sessionId)).toBe(true);
    expect(getActiveGatewayRootWorkCount()).toBe(1);

    const cancelRespond = vi.fn();
    await wizardHandlers["wizard.cancel"]!({
      params: { sessionId: ` ${sessionId} ` },
      respond: cancelRespond,
      context,
    } as never);

    expect(cancelRespond.mock.calls[0]?.[0]).toBe(true);
    expect(cancelRespond.mock.calls[0]?.[1]).toMatchObject({ status: "cancelled" });

    runnerSettled.resolve();
    const session = tracker.wizardSessions.get(sessionId);
    if (session) {
      await whenAdmittedWizardSessionSettled(session).catch(() => undefined);
    }
  });
});
