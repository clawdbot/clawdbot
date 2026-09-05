// @vitest-environment jsdom
import { buildSystemAgentSessionInvalidatedErrorDetails } from "@openclaw/gateway-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../api/gateway.ts";
import { CUSTODIAN_PANEL_TOGGLE_EVENT } from "../components/panel-toggle-contract.ts";
import { custodianAlertStore } from "../pages/custodian/custodian-alert-store.ts";
import { createContext } from "../pages/custodian/custodian-page.test-harness.ts";
import { CustodianSessionStore } from "../pages/custodian/custodian-session-store.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import { QUICK_ACTIONS_QUESTION } from "../test-helpers/custodian-quick-actions.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { createUpdateRunFixture } from "../test-helpers/update-run.ts";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";
import { createApplicationOverlays } from "./overlays.ts";
import { projectUpdateRunFailure } from "./update-overlay-helpers.ts";
import type { UpdateFailureTriage, UpdateTriageAdmission } from "./update-overlay-helpers.ts";
import { presentUpdateFailureTriage } from "./update-triage.runtime.ts";

const FAILURE: UpdateFailureTriage = {
  id: "recorded-attempt",
  outcome: "failed",
  banner: { tone: "danger", text: "Build failed" },
  attempt: {
    timestampMs: 1_000,
    status: "error",
    reason: "build-failed",
    installKind: "git",
    beforeVersion: "1.0.0",
    beforeSha: "1111111111111111111111111111111111111111",
    afterVersion: "1.0.0",
    afterSha: "2222222222222222222222222222222222222222",
    failure: { step: "build", detail: "Disk is full" },
  },
};

function typeComposerDraft(surface: HTMLElement, draft: string): HTMLTextAreaElement {
  const composer = surface.querySelector("textarea");
  if (!composer) {
    throw new Error("Expected a ready composer");
  }
  composer.value = draft;
  composer.dispatchEvent(new Event("input", { bubbles: true }));
  return composer;
}

afterEach(() => {
  custodianAlertStore.dismiss();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("update triage presentation", () => {
  it.each(["reply", "session invalidation"])(
    "preserves a draft after diagnostic %s",
    async (outcome) => {
      let invalidateSession = outcome === "session invalidation";
      const request = vi.fn(
        async (_method: string, params: { sessionId: string; message?: string }) => {
          if (params.message && invalidateSession) {
            invalidateSession = false;
            throw new GatewayRequestError({
              code: "UNAVAILABLE",
              message: "The diagnostic session expired.",
              details: buildSystemAgentSessionInvalidatedErrorDetails(),
            });
          }
          return {
            sessionId: params.sessionId,
            reply: "Inspecting the failed build before proposing a repair.",
            ...(!params.message ? { question: QUICK_ACTIONS_QUESTION } : {}),
          };
        },
      );
      const { context } = createContext(request);
      const provider = createApplicationContextProvider(context);
      const surface = document.createElement("openclaw-custodian-surface");
      surface.store = new CustodianSessionStore();
      provider.append(surface);
      document.body.append(provider);
      await surface.updateComplete;
      await vi.waitFor(() => expect(surface.store.canSend).toBe(true));
      const draft = "Keep my unsent question";
      const composer = typeComposerDraft(surface, draft);
      const admission = { isCurrent: () => true, admit: vi.fn(() => true) };
      const openPanel = vi.fn();
      window.addEventListener(CUSTODIAN_PANEL_TOGGLE_EVENT, openPanel, { once: true });

      presentUpdateFailureTriage(context, FAILURE, admission);
      await vi.waitFor(() => expect(admission.admit).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(surface.store.canSend).toBe(true));
      await surface.updateComplete;

      expect(openPanel).toHaveBeenCalledOnce();
      const questions = request.mock.calls.filter(([, params]) => "message" in params);
      expect(questions).toHaveLength(1);
      expect(questions[0]?.[1]).toMatchObject({
        message: expect.stringContaining("Disk is full"),
      });
      expect(questions[0]?.[1].message).toContain("1111111111111111111111111111111111111111");
      expect(questions[0]?.[1].message).toContain("2222222222222222222222222222222222222222");
      expect(custodianAlertStore.alert?.question).toContain("Do not retry the update");
      expect(surface.textContent).toContain("build-failed");
      expect(surface.textContent).toContain("openclaw triage");
      if (outcome === "session invalidation") {
        const recovery = request.mock.calls.at(-1)?.[1];
        expect(recovery?.sessionId).not.toBe(questions[0]?.[1].sessionId);
        expect(recovery).not.toHaveProperty("message");
        expect(surface.textContent).toContain("started a fresh session");
      }
      surface.requestUpdate();
      await surface.updateComplete;
      expect(admission.admit).toHaveBeenCalledOnce();
      expect(composer.value).toBe(draft);

      composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await vi.waitFor(() =>
        expect(request.mock.calls.filter(([, params]) => "message" in params)).toHaveLength(2),
      );
      await surface.updateComplete;
      expect(request.mock.calls.at(-1)?.[1]).toMatchObject({ message: draft });
      expect(composer.value).toBe("");
      expect(admission.admit).toHaveBeenCalledOnce();
    },
  );

  it("waits for an active workflow question before admitting diagnostic triage", async () => {
    const request = vi.fn(
      async (_method: string, params: { sessionId: string; message?: string }) => ({
        sessionId: params.sessionId,
        reply: "Review the current access policy.",
        ...(!params.message
          ? {
              question: {
                id: "access",
                header: "Access",
                question: "How should OpenClaw work?",
                options: [{ label: "Full access" }, { label: "Ask first" }],
              },
            }
          : {}),
      }),
    );
    const { context } = createContext(request);
    const provider = createApplicationContextProvider(context);
    const surface = document.createElement("openclaw-custodian-surface");
    surface.store = new CustodianSessionStore();
    provider.append(surface);
    document.body.append(provider);
    await vi.waitFor(() =>
      expect(surface.querySelector('[data-option-value="Ask first"]')).not.toBeNull(),
    );
    const draft = "Keep my workflow question";
    const composer = typeComposerDraft(surface, draft);
    const admission = { isCurrent: () => true, admit: vi.fn(() => true) };

    presentUpdateFailureTriage(context, FAILURE, admission);
    await surface.updateComplete;

    expect(admission.admit).not.toHaveBeenCalled();
    expect(request.mock.calls.filter(([, params]) => params.message)).toHaveLength(0);
    surface.querySelector<HTMLButtonElement>('[data-option-value="Ask first"]')?.click();
    await vi.waitFor(() => expect(admission.admit).toHaveBeenCalledOnce());
    const messages = request.mock.calls.flatMap(([, params]) => params.message ?? []);
    expect(messages).toEqual(["Ask first", expect.stringContaining("Disk is full")]);
    await surface.updateComplete;
    expect(composer.value).toBe(draft);
  });

  it("refreshes queued run facts before sending and never rearms a consumed diagnosis", async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    let run = createUpdateRunFixture();
    const request = vi.fn(
      async (method: string, params?: { sessionId?: string; message?: string }) => {
        if (method === "update.run") {
          return { ok: true, runId: run.runId };
        }
        if (method === "update.runs.get") {
          return { run };
        }
        if (method === "update.status") {
          return { activeRun: run.status === "running" ? run : null, lastRun: run };
        }
        return method === "openclaw.chat"
          ? {
              sessionId: params?.sessionId,
              reply: "Review the current access policy.",
              ...(!params?.message
                ? {
                    question: {
                      id: "access",
                      header: "Access",
                      question: "How should OpenClaw work?",
                      options: [{ label: "Full access" }, { label: "Ask first" }],
                    },
                  }
                : {}),
            }
          : {};
      },
    );
    const { context, emitGatewayEvent, setGatewaySnapshot } = createContext(request);
    const onUpdateFailure = vi.fn(
      (failure: UpdateFailureTriage, admission: UpdateTriageAdmission) =>
        presentUpdateFailureTriage(context, failure, admission),
    );
    const overlays = createApplicationOverlays(context.gateway, { onUpdateFailure });
    const provider = createApplicationContextProvider(context);
    const surface = document.createElement("openclaw-custodian-surface");
    surface.store = new CustodianSessionStore();
    provider.append(surface);
    document.body.append(provider);
    const diagnosticMessages = () =>
      request.mock.calls.flatMap(([method, params]) =>
        method === "openclaw.chat" && params?.message ? [params.message] : [],
      );
    try {
      await vi.waitFor(() =>
        expect(surface.querySelector('[data-option-value="Ask first"]')).not.toBeNull(),
      );
      await overlays.runUpdate();
      setGatewaySnapshot({ phase: "reconnecting" });
      run = {
        ...run,
        phase: "finished",
        status: "failed",
        reason: "restart-revision-mismatch",
        finishedAtMs: 2_000,
        updatedAtMs: 2_000,
      };
      setGatewaySnapshot({ phase: "connected" });
      await vi.waitFor(() =>
        expect(custodianAlertStore.alert?.question).toContain("restart-revision-mismatch"),
      );
      const staleAdmission = onUpdateFailure.mock.calls[0]?.[1];
      await overlays.refreshUpdateStatus();
      expect(onUpdateFailure).toHaveBeenCalledOnce();
      expect(staleAdmission?.isCurrent()).toBe(true);

      run = {
        ...run,
        updatedAtMs: 3_000,
        reason: "build-failed",
        steps: [{ step: "build", status: "failed", detail: "Disk is full" }],
      };
      emitGatewayEvent({ event: "update.run.changed", payload: run });
      await vi.waitFor(() => expect(custodianAlertStore.alert?.question).toContain("Disk is full"));
      expect(custodianAlertStore.alert?.question).not.toContain("restart-revision-mismatch");
      expect(staleAdmission?.isCurrent()).toBe(false);
      expect(onUpdateFailure).toHaveBeenCalledTimes(2);
      await overlays.refreshUpdateStatus();
      expect(onUpdateFailure).toHaveBeenCalledTimes(2);
      expect(diagnosticMessages()).toEqual([]);

      surface.querySelector<HTMLButtonElement>('[data-option-value="Ask first"]')?.click();
      await vi.waitFor(() => expect(diagnosticMessages()).toHaveLength(2));
      expect(diagnosticMessages()).toEqual(["Ask first", expect.stringContaining("Disk is full")]);
      expect(diagnosticMessages()[1]).toContain(run.runId);
      expect(diagnosticMessages()[1]).toContain("Do not retry the update");
      await vi.waitFor(() => expect(surface.store.sending).toBe(false));

      run = { ...run, updatedAtMs: 4_000, reason: "doctor-failed" };
      emitGatewayEvent({ event: "update.run.changed", payload: run });
      await vi.waitFor(() =>
        expect(overlays.snapshot.recordedUpdateAttempt?.reason).toBe("doctor-failed"),
      );
      expect(onUpdateFailure).toHaveBeenCalledTimes(2);
      expect(diagnosticMessages()).toHaveLength(2);
    } finally {
      overlays.dispose();
    }
  });

  it("waits for the run to finish and diagnoses once even when campaign metadata is stale", async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    const schedule = {
      channel: "stable",
      autoEnabled: true,
      campaign: {
        id: "applying-campaign",
        state: "applying",
        announcedAtMs: 1_000,
        forceAtMs: 2_000,
        updatedAtMs: 2_000,
      },
    } as const;
    let run = createUpdateRunFixture({
      phase: "verifying",
      origin: { campaignId: schedule.campaign.id },
    });
    const request = vi.fn(
      async (method: string, params?: { sessionId?: string; message?: string }) => {
        if (method === "update.run") {
          return { ok: true, runId: run.runId };
        }
        if (method === "update.runs.get") {
          return { run };
        }
        if (method === "update.status") {
          return { activeRun: run.status === "running" ? run : null, lastRun: run, schedule };
        }
        return method === "openclaw.chat"
          ? { sessionId: params?.sessionId, reply: "Ready to inspect the update." }
          : {};
      },
    );
    const diagnosticMessages = () =>
      request.mock.calls.flatMap(([method, params]) =>
        method === "openclaw.chat" && params?.message ? [params.message] : [],
      );
    const { context, emitGatewayEvent, setGatewaySnapshot } = createContext(request);
    const overlays = createApplicationOverlays(context.gateway, {
      onUpdateFailure: (failure, admission) =>
        presentUpdateFailureTriage(context, failure, admission),
    });
    const provider = createApplicationContextProvider(context);
    const surface = document.createElement("openclaw-custodian-surface");
    surface.store = new CustodianSessionStore();
    provider.append(surface);
    document.body.append(provider);
    try {
      await vi.waitFor(() => expect(surface.store.canSend).toBe(true));
      await overlays.refreshUpdateStatus();
      expect(overlays.snapshot.updateRunning).toBe(true);
      expect(diagnosticMessages()).toEqual([]);
      setGatewaySnapshot({ phase: "reconnecting" });
      setGatewaySnapshot({ phase: "connected" });
      await overlays.refreshUpdateStatus();
      expect(diagnosticMessages()).toEqual([]);
      run = {
        ...run,
        phase: "finished",
        status: "failed",
        reason: "restart-unhealthy",
        finishedAtMs: 3_000,
        updatedAtMs: 3_000,
      };
      emitGatewayEvent({ event: "update.run.changed", payload: run });
      await vi.waitFor(() =>
        expect(diagnosticMessages()).toEqual([expect.stringContaining("Do not retry the update")]),
      );
      expect(overlays.snapshot.updateRunning).toBe(false);
      expect(overlays.snapshot.updateSchedule?.campaign?.state).toBe("applying");
      await overlays.refreshUpdateStatus();
      emitGatewayEvent({ event: "update.run.changed", payload: run });
      setGatewaySnapshot({ phase: "reconnecting" });
      setGatewaySnapshot({ phase: "connected" });
      await overlays.refreshUpdateStatus();
      expect(diagnosticMessages()).toHaveLength(1);
    } finally {
      overlays.dispose();
    }
  });

  it.each(["offline", "missing capability", "non-admin", "stale owner"])(
    "does not claim an agent launch for %s",
    (boundary) => {
      const request = vi.fn();
      const { context, setGatewaySnapshot } = createContext(
        request,
        boundary === "missing capability" ? [] : ["openclaw.chat"],
      );
      if (boundary === "offline") {
        setGatewaySnapshot({ phase: "reconnecting" });
      }
      if (boundary === "non-admin") {
        setGatewaySnapshot({
          hello: {
            auth: { role: "operator", scopes: ["operator.read"] },
          } as ApplicationGatewaySnapshot["hello"],
        });
      }
      const admission = { isCurrent: () => boundary !== "stale owner", admit: vi.fn(() => true) };
      presentUpdateFailureTriage(context, FAILURE, admission);

      expect(admission.admit).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
      expect(custodianAlertStore.alert).toBeNull();
      if (boundary === "stale owner") {
        expect(context.navigate).not.toHaveBeenCalled();
      } else {
        expect(context.navigate).toHaveBeenCalledExactlyOnceWith("updates");
      }
    },
  );

  it("keeps recorded facts visible without sending when no model is configured", async () => {
    const request = vi.fn();
    const { context } = createContext(request, ["openclaw.chat"], {
      agentsList: { defaultId: "main", mainKey: "main", scope: "global", agents: [{ id: "main" }] },
    });
    const provider = createApplicationContextProvider(context);
    const surface = document.createElement("openclaw-custodian-surface");
    surface.store = new CustodianSessionStore();
    provider.append(surface);
    document.body.append(provider);
    const admission = { isCurrent: () => true, admit: vi.fn(() => true) };
    presentUpdateFailureTriage(context, FAILURE, admission);
    await surface.updateComplete;

    expect(surface.textContent).toContain("Reason code: build-failed");
    expect(surface.textContent).toContain(
      "Before update: 1111111111111111111111111111111111111111",
    );
    expect(surface.textContent).toContain("Disk is full");
    expect(surface.textContent).toContain("openclaw triage");
    expect(admission.admit).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["administrator", "profile", "Gateway"])(
    "retires the facts before transport when %s changes during turn preparation",
    async (boundary) => {
      const request = vi.fn(async (method: string, params?: { sessionId?: string }) => {
        if (method === "update.run") {
          return {
            ok: false,
            result: { status: "error" },
            sentinel: {
              payload: {
                kind: "update",
                status: "error",
                ts: 1_000,
                stats: {
                  handoffId: "retired-attempt",
                  reason: "build-failed",
                  steps: [
                    { name: "build", log: { exitCode: 1, stderrTail: "Private diagnostic cause" } },
                  ],
                },
              },
            },
          };
        }
        return method === "openclaw.chat"
          ? { sessionId: params?.sessionId, reply: "Ready to inspect the installation." }
          : {};
      });
      const { context, setGatewaySnapshot } = createContext(request);
      const overlays = createApplicationOverlays(context.gateway, {
        onUpdateFailure: (failure, admission) =>
          presentUpdateFailureTriage(context, failure, admission),
      });
      const provider = createApplicationContextProvider(context);
      const surface = document.createElement("openclaw-custodian-surface");
      surface.store = new CustodianSessionStore();
      provider.append(surface);
      document.body.append(provider);
      await surface.updateComplete;
      await vi.waitFor(() => expect(surface.store.sending).toBe(false));
      let retire = true;
      const unsubscribe = surface.store.subscribe(() => {
        if (!retire || !surface.store.sending) {
          return;
        }
        retire = false;
        if (boundary === "administrator") {
          setGatewaySnapshot({
            hello: {
              ...context.gateway.snapshot.hello,
              auth: { role: "operator", scopes: ["operator.read"] },
            } as ApplicationGatewaySnapshot["hello"],
          });
        } else if (boundary === "profile") {
          setGatewaySnapshot({
            selfUser: { id: "replacement-profile" } as NonNullable<
              ApplicationGatewaySnapshot["selfUser"]
            >,
          });
        } else {
          context.gateway.connection.gatewayUrl = "ws://replacement.test";
          setGatewaySnapshot({});
        }
      });
      try {
        await overlays.runUpdate();
        await vi.waitFor(() => expect(retire).toBe(false));
        await surface.updateComplete;

        expect(
          request.mock.calls.filter(
            ([method, params]) => method === "openclaw.chat" && params && "message" in params,
          ),
        ).toHaveLength(0);
        expect(custodianAlertStore.alert).toBeNull();
        expect(surface.textContent).not.toContain("Private diagnostic cause");
        expect(
          surface.store.messages.every(
            (message) => !message.text.includes("Private diagnostic cause"),
          ),
        ).toBe(true);
      } finally {
        unsubscribe();
        overlays.dispose();
      }
    },
  );

  it.each(["consumed admission", "throw before send", "reject before send"])(
    "does not retain an unsent automatic question after %s",
    async (failure) => {
      let rejectDiagnostic = failure !== "consumed admission";
      const request = vi.fn((_method: string, params: { sessionId: string; message?: string }) => {
        if (params.message && rejectDiagnostic) {
          rejectDiagnostic = false;
          const error = new Error("Diagnostic transport is unavailable");
          if (failure === "throw before send") {
            throw error;
          }
          return Promise.reject(error);
        }
        return Promise.resolve({
          sessionId: params.sessionId,
          reply: "Ready.",
          ...(!params.message ? { question: QUICK_ACTIONS_QUESTION } : {}),
        });
      });
      const { context } = createContext(request);
      const provider = createApplicationContextProvider(context);
      const surface = document.createElement("openclaw-custodian-surface");
      surface.store = new CustodianSessionStore();
      provider.append(surface);
      document.body.append(provider);
      await surface.updateComplete;
      await vi.waitFor(() => expect(surface.store.canSend).toBe(true));
      const draft = "Keep my question after rejected triage";
      const composer = typeComposerDraft(surface, draft);
      const admission = {
        isCurrent: () => true,
        admit: vi.fn(() => failure !== "consumed admission"),
      };
      presentUpdateFailureTriage(context, FAILURE, admission);
      await vi.waitFor(() => expect(admission.admit).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(surface.store.sending).toBe(false));

      const rejectedRequests = failure === "consumed admission" ? 0 : 1;
      expect(request.mock.calls.filter(([, params]) => "message" in params)).toHaveLength(
        rejectedRequests,
      );
      expect(
        surface.store.messages
          .filter((message) => message.role === "user")
          .map((message) => message.text),
      ).toEqual([]);
      expect(surface.store.hasRealUserTurn()).toBe(false);
      expect(surface.store.canRetry()).toBe(false);
      await surface.updateComplete;
      expect(surface.querySelector(".chat-group.user")).toBeNull();
      expect(surface.querySelector<HTMLButtonElement>(".option-card__choice")?.disabled).toBe(
        false,
      );
      expect(composer.value).toBe(draft);

      composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await vi.waitFor(() =>
        expect(request.mock.calls.filter(([, params]) => "message" in params)).toHaveLength(
          rejectedRequests + 1,
        ),
      );
      await surface.updateComplete;
      expect(request.mock.calls.at(-1)?.[1]).toMatchObject({ message: draft });
      expect(composer.value).toBe("");
      expect(admission.admit).toHaveBeenCalledOnce();
    },
  );

  it("bounds and redacts the recorded run identity and failure before sending diagnostics", () => {
    const { context } = createContext(vi.fn());
    const run = createUpdateRunFixture({
      phase: "finished",
      status: "failed",
      reason: "build-failed",
      finishedAtMs: 1_700_000_000_000,
      before: { version: "2026.9.1", sha: "1".repeat(40) },
      after: { version: "2026.9.2", sha: "2".repeat(40) },
      steps: [
        {
          step: "build",
          status: "failed",
          detail: `Build failed: token=synthetic-secret ${"x".repeat(8_000)}`,
        },
      ],
    });
    const failure = projectUpdateRunFailure(run);
    expect(failure).not.toBeNull();
    if (!failure) {
      throw new Error("Expected a failed run projection");
    }
    presentUpdateFailureTriage(context, failure, { isCurrent: () => true, admit: () => true });

    const alert = custodianAlertStore.alert;
    expect(alert?.question).toContain(run.runId);
    expect(alert?.question).toContain("2026.9.1");
    expect(alert?.question).toContain("2026.9.2");
    expect(alert?.question).toContain("1".repeat(40));
    expect(alert?.question).toContain("2".repeat(40));
    expect(alert?.question).toContain("Build failed");
    expect(alert?.question).toContain("2023-11-14T22:13:20.000Z");
    expect(alert?.question).not.toContain("synthetic-secret");
    expect(alert?.question.length).toBeLessThanOrEqual(2_400);
    expect(alert?.facts.every((fact) => fact.length <= 240)).toBe(true);
  });
});
