import { describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { WizardSession } from "../wizard/session.js";
import { createWizardSessionTracker } from "./server-wizard-sessions.js";

describe("createWizardSessionTracker", () => {
  it("retains an uncollected terminal result before reaping it", async () => {
    let now = 1_000;
    const tracker = createWizardSessionTracker({ now: () => now });
    const terminal = new WizardSession(async () => {});
    tracker.trackWizardSession(terminal, undefined, "finished");
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
    tracker.trackWizardSession(running, undefined, "running");

    expect(tracker.findRunningWizard()).toBe("running");
    expect(tracker.wizardSessions.get("running")?.session).toBe(running);
    running.cancel();
  });

  it("keeps a cancelled session active until its runner settles", async () => {
    const tracker = createWizardSessionTracker();
    const releaseRunner = createDeferred();
    const cancelled = new WizardSession(async () => {
      await releaseRunner.promise;
    });
    tracker.trackWizardSession(cancelled, undefined, "cancelled");

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

  it("cancels only sessions owned by the disconnected connection", async () => {
    const tracker = createWizardSessionTracker();
    const owned = new WizardSession(async (prompter) => {
      await prompter.note("owned");
    });
    const other = new WizardSession(async (prompter) => {
      await prompter.note("other");
    });
    const unowned = new WizardSession(async (prompter) => {
      await prompter.note("unowned");
    });
    tracker.trackWizardSession(owned, "owner-connection", "owned");
    tracker.trackWizardSession(other, "other-connection", "other");
    tracker.trackWizardSession(unowned, undefined, "unowned");

    tracker.handleWizardDisconnect("owner-connection");

    await expect.poll(() => owned.getStatus()).toBe("cancelled");
    expect(other.getStatus()).toBe("running");
    expect(unowned.getStatus()).toBe("running");
    other.cancel();
    unowned.cancel();
    await Promise.all([other.whenSettled(), unowned.whenSettled()]);
  });
});
