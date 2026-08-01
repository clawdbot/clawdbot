import { describe, expect, it } from "vitest";
import { createDeferred } from "../shared/deferred.js";
import { WizardSession } from "../wizard/session.js";
import { createWizardSessionTracker } from "./server-wizard-sessions.js";

describe("createWizardSessionTracker", () => {
  it("retains an uncollected terminal result before reaping it", async () => {
    let now = 1_000;
    const tracker = createWizardSessionTracker({ now: () => now });
    const terminal = new WizardSession(async () => {});
    tracker.wizardSessions.set("finished", terminal);
    await terminal.next();

    expect(tracker.findRunningWizard()).toBeNull();
    expect(tracker.wizardSessions.has("finished")).toBe(true);

    now += 5 * 60 * 1000 - 1;
    expect(tracker.findRunningWizard()).toBeNull();
    expect(tracker.wizardSessions.has("finished")).toBe(true);

    now += 1;
    expect(tracker.findRunningWizard()).toBeNull();
    expect(tracker.wizardSessions.has("finished")).toBe(false);
  });

  it("retains and reports the running session", () => {
    const tracker = createWizardSessionTracker();
    const running = new WizardSession(async (prompter) => {
      await prompter.note("waiting");
    });
    tracker.wizardSessions.set("running", running);

    expect(tracker.findRunningWizard()).toBe("running");
    expect(tracker.wizardSessions.get("running")).toBe(running);
    running.cancel();
  });

  it("keeps a cancelled session active until its runner settles", async () => {
    const tracker = createWizardSessionTracker();
    const releaseRunner = createDeferred();
    const cancelled = new WizardSession(async () => {
      await releaseRunner.promise;
    });
    tracker.wizardSessions.set("cancelled", cancelled);

    expect(cancelled.cancel()).toBe(true);
    tracker.purgeWizardSession("cancelled");
    expect(tracker.findRunningWizard()).toBe("cancelled");
    expect(tracker.wizardSessions.has("cancelled")).toBe(true);

    releaseRunner.resolve();
    await expect.poll(() => cancelled.isSettled()).toBe(true);
    expect(tracker.findRunningWizard()).toBeNull();
    tracker.purgeWizardSession("cancelled");
    expect(tracker.wizardSessions.has("cancelled")).toBe(false);
  });
});
