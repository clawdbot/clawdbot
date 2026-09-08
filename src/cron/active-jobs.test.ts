// Unit coverage for the active-job accounting the heartbeat busy guard depends on.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import { importFreshModule } from "../plugin-sdk/test-helpers/import-fresh.js";
import {
  advanceCronActiveJobGeneration,
  bindCronJobAdmittedRun,
  bindCronSelfRemovalCommitGuard,
  clearCronJobActive,
  hasActiveCronJobs,
  hasActiveCronJobsExceptMarkers,
  markCronJobActive,
  noteActiveCronJobRemoval,
  noteActiveCronJobScheduleMutation,
  noteActiveCronJobTriggerMutation,
  onCronJobInactive,
  resetCronActiveJobs,
} from "./active-jobs.js";

afterEach(() => {
  resetCronActiveJobs();
});

describe("hasActiveCronJobsExceptMarkers", () => {
  it("discounts only the named job's own marker", () => {
    const marker = markCronJobActive("nightly-report");

    expect(hasActiveCronJobs()).toBe(true);
    expect(hasActiveCronJobsExceptMarkers([marker!])).toBe(false);
  });

  it("still reports busy while an unrelated job is active", () => {
    const marker = markCronJobActive("nightly-report");
    markCronJobActive("different-job");

    // The owning job must not be waved through while another run holds a marker:
    // Cron executes jobs up to the built-in concurrency limit.
    expect(hasActiveCronJobsExceptMarkers([marker!])).toBe(true);
  });

  it("discounts every exact coalesced owner", () => {
    const first = markCronJobActive("first-report");
    const second = markCronJobActive("second-report");

    expect(hasActiveCronJobsExceptMarkers([first!, second!])).toBe(false);
  });

  it("reports idle once the unrelated job clears", () => {
    const marker = markCronJobActive("nightly-report");
    const otherMarker = markCronJobActive("different-job");
    clearCronJobActive("different-job", otherMarker);

    expect(hasActiveCronJobsExceptMarkers([marker!])).toBe(false);
  });

  it("does not discount a replacement marker with the same job id", () => {
    const staleMarker = markCronJobActive("nightly-report");
    const replacementMarker = markCronJobActive("nightly-report");

    expect(hasActiveCronJobsExceptMarkers([staleMarker!])).toBe(true);
    expect(hasActiveCronJobsExceptMarkers([replacementMarker!])).toBe(false);
  });
});

describe.each(["same module", "reload before guard", "reload after guard"])(
  "active cron self-removal ownership: %s",
  (moduleBoundary) => {
    it.each([
      "active owner",
      "closed admission",
      "aborted run",
      "expired caller",
      "replaced marker",
      "replaced admission",
      "retired generation",
      "copied guard",
      "different instance",
    ] as const)("keeps self-removal bound to the %s", async (scenario) => {
      const jobId = "self-removing-job";
      const marker = markCronJobActive(jobId)!;
      const controller = new AbortController();
      const admission = prepareAgentRunAdmission({
        cfg: {},
        operationalRunInstance: createOperationalRunInstanceRef("self-removal-run"),
        facts: {
          runId: "self-removal-run",
          agentId: "main",
          ingress: { kind: "schedule", boundary: "cron.isolated-agent", state: "present" },
        },
      });
      const replacement = prepareAgentRunAdmission({
        cfg: {},
        operationalRunInstance: createOperationalRunInstanceRef("replacement-run"),
        facts: {
          runId: "replacement-run",
          agentId: "main",
          ingress: { kind: "schedule", boundary: "cron.isolated-agent", state: "present" },
        },
      });
      try {
        const context = await admission.admit("embedded");
        bindCronJobAdmittedRun(marker, context, controller.signal);
        let callerActive = true;
        const commitGuard = vi.fn();
        const bindingModule =
          moduleBoundary === "reload before guard"
            ? await importFreshModule<typeof import("./active-jobs.js")>(
                import.meta.url,
                "./active-jobs.js?cron-self-removal-before-guard",
              )
            : { bindCronSelfRemovalCommitGuard };
        bindingModule.bindCronSelfRemovalCommitGuard(
          jobId,
          scenario === "different instance"
            ? createOperationalRunInstanceRef(context.operationalRunInstance.runId)
            : context.operationalRunInstance,
          commitGuard,
          () => {
            if (!callerActive) {
              throw new Error("caller expired");
            }
          },
        );
        let currentMarker = marker;
        if (scenario === "closed admission") {
          admission.close();
        } else if (scenario === "aborted run") {
          controller.abort();
        } else if (scenario === "expired caller") {
          callerActive = false;
        } else if (scenario === "replaced admission") {
          bindCronJobAdmittedRun(marker, await replacement.admit("embedded"), controller.signal);
        } else if (scenario === "replaced marker" || scenario === "retired generation") {
          if (scenario === "retired generation") {
            advanceCronActiveJobGeneration();
          }
          currentMarker = markCronJobActive(jobId)!;
        }
        const cancel = vi.fn();
        currentMarker.cancellation = { kind: "bound", cancel };

        const removalGuard = scenario === "copied guard" ? () => commitGuard() : commitGuard;
        const removalModule =
          moduleBoundary === "same module"
            ? { noteActiveCronJobRemoval }
            : await importFreshModule<typeof import("./active-jobs.js")>(
                import.meta.url,
                "./active-jobs.js?cron-self-removal-after-guard",
              );
        expect(removalModule.noteActiveCronJobRemoval(jobId, removalGuard)).toBe(currentMarker);
        expect(currentMarker.jobRemoved).toBe(true);
        expect(hasActiveCronJobs()).toBe(true);
        if (scenario === "active owner") {
          expect(cancel).not.toHaveBeenCalled();
        } else {
          expect(cancel).toHaveBeenCalledExactlyOnceWith("Cron job removed by operator.");
        }
      } finally {
        admission.close();
        replacement.close();
      }
    });
  },
);

describe("active cron schedule ownership", () => {
  it("notifies only the removed marker when a same-id run replaces it", () => {
    const removedMarker = markCronJobActive("reused-job");
    const onRemovedInactive = vi.fn();
    onCronJobInactive(noteActiveCronJobRemoval("reused-job"), onRemovedInactive);
    const replacementMarker = markCronJobActive("reused-job");

    clearCronJobActive("reused-job", replacementMarker);
    expect(onRemovedInactive).not.toHaveBeenCalled();

    clearCronJobActive("reused-job", removedMarker);
    expect(onRemovedInactive).toHaveBeenCalledOnce();
  });

  it("records durable job removal without releasing the active run marker", () => {
    const marker = markCronJobActive("removed-job");

    noteActiveCronJobRemoval("removed-job");

    expect(marker?.scheduleMutated).toBe(true);
    expect(marker?.jobRemoved).toBe(true);
    expect(marker?.cancellation).toEqual({
      kind: "requested",
      reason: "Cron job removed by operator.",
    });
    expect(hasActiveCronJobs()).toBe(true);
  });

  it("does not mistake an ordinary schedule edit for job removal", () => {
    const marker = markCronJobActive("updated-job");

    noteActiveCronJobScheduleMutation("updated-job");

    expect(marker?.scheduleMutated).toBe(true);
    expect(marker?.jobRemoved).toBeUndefined();
  });

  it("does not create active markers when removing an idle job", () => {
    noteActiveCronJobRemoval("idle-removed-job");

    expect(hasActiveCronJobs()).toBe(false);
  });

  it("records durable schedule mutations on the admitted active run", () => {
    const marker = markCronJobActive("rescheduled-job");

    noteActiveCronJobScheduleMutation("rescheduled-job");

    expect(marker?.scheduleMutated).toBe(true);
  });

  it("records trigger mutations without retiring schedule ownership", () => {
    const marker = markCronJobActive("trigger-edited-job");

    noteActiveCronJobTriggerMutation("trigger-edited-job");

    expect(marker?.triggerMutated).toBe(true);
    expect(marker?.scheduleMutated).toBeUndefined();
  });

  it("keeps trigger mutation ownership after the script is edited back", () => {
    const marker = markCronJobActive("trigger-restored-job");

    noteActiveCronJobTriggerMutation("trigger-restored-job");
    noteActiveCronJobTriggerMutation("trigger-restored-job");

    expect(marker?.triggerMutated).toBe(true);
  });

  it("does not create trigger markers for an idle job", () => {
    noteActiveCronJobTriggerMutation("idle-trigger-job");

    expect(hasActiveCronJobs()).toBe(false);
  });

  it("keeps a mutation after the schedule is edited back to its original value", () => {
    const marker = markCronJobActive("rescheduled-job");

    noteActiveCronJobScheduleMutation("rescheduled-job");
    noteActiveCronJobScheduleMutation("rescheduled-job");

    expect(marker?.scheduleMutated).toBe(true);
  });

  it("attributes later edits only to the replacement active run", () => {
    const retiredMarker = markCronJobActive("rescheduled-job");
    clearCronJobActive("rescheduled-job", retiredMarker);
    const replacementMarker = markCronJobActive("rescheduled-job");

    noteActiveCronJobScheduleMutation("rescheduled-job");

    expect(retiredMarker?.scheduleMutated).toBeUndefined();
    expect(replacementMarker?.scheduleMutated).toBe(true);
  });

  it("does not create ownership markers for jobs without an active run", () => {
    noteActiveCronJobScheduleMutation("idle-job");

    expect(hasActiveCronJobs()).toBe(false);
  });

  it("keeps schedule ownership isolated across concurrent active jobs", () => {
    const markers = Array.from({ length: 64 }, (_, index) =>
      markCronJobActive(`rescheduled-job-${index}`),
    );

    for (let index = 0; index < markers.length; index += 2) {
      noteActiveCronJobScheduleMutation(`rescheduled-job-${index}`);
      noteActiveCronJobScheduleMutation(`rescheduled-job-${index}`);
    }

    for (const [index, marker] of markers.entries()) {
      expect(marker?.scheduleMutated).toBe(index % 2 === 0 ? true : undefined);
    }
  });
});
