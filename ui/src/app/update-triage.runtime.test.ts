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
import type { ApplicationGatewaySnapshot } from "./gateway.ts";
import { createApplicationOverlays } from "./overlays.ts";
import type {
  UpdateFailureTriage,
  UpdateRestartStatusResponse,
  UpdateTriageAdmission,
} from "./update-overlay-helpers.ts";
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

  it("refreshes queued same-attempt facts before sending and never rearms a consumed diagnosis", async () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    let status: UpdateRestartStatusResponse = {};
    const request = vi.fn(
      async (method: string, params?: { sessionId?: string; message?: string }) => {
        if (method === "update.run") {
          return {
            ok: true,
            handoff: { status: "started" },
            result: { status: "skipped", reason: "managed-service-handoff-started" },
            sentinel: { payload: { stats: { handoffId: "queued-handoff" } } },
          };
        }
        if (method === "update.status") {
          return status;
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
    try {
      await vi.waitFor(() =>
        expect(surface.querySelector('[data-option-value="Ask first"]')).not.toBeNull(),
      );
      emitGatewayEvent({
        event: "update.available",
        payload: {
          updateAvailable: { channel: "stable", currentVersion: "1.0.0", latestVersion: "2.0.0" },
        },
      });
      await overlays.runUpdate();
      setGatewaySnapshot({ phase: "reconnecting" });
      status = {
        sentinel: {
          kind: "update",
          status: "ok",
          ts: 2_000,
          stats: { handoffId: "queued-handoff", after: { version: "1.0.0" } },
        },
      };
      setGatewaySnapshot({ phase: "connected" });
      await vi.waitFor(() =>
        expect(custodianAlertStore.alert?.question).toContain("Expected v2.0.0, running v1.0.0"),
      );
      const staleAdmission = onUpdateFailure.mock.calls[0]?.[1];
      await overlays.refreshUpdateStatus();
      expect(onUpdateFailure).toHaveBeenCalledOnce();
      expect(staleAdmission?.isCurrent()).toBe(true);

      status = {
        sentinel: {
          kind: "update",
          status: "error",
          ts: 3_000,
          stats: {
            handoffId: "queued-handoff",
            reason: "build-failed",
            steps: [{ name: "build", log: { exitCode: 1, stderrTail: "Disk is full" } }],
          },
        },
      };
      await overlays.refreshUpdateStatus();
      await surface.updateComplete;
      expect(custodianAlertStore.alert?.question).toContain("Disk is full");
      expect(custodianAlertStore.alert?.question).not.toContain("Expected v2.0.0");
      expect(staleAdmission?.isCurrent()).toBe(false);
      expect(onUpdateFailure).toHaveBeenCalledTimes(2);
      await overlays.refreshUpdateStatus();
      expect(onUpdateFailure).toHaveBeenCalledTimes(2);
      expect(
        request.mock.calls.filter(
          ([method, params]) => method === "openclaw.chat" && params?.message,
        ),
      ).toHaveLength(0);

      surface.querySelector<HTMLButtonElement>('[data-option-value="Ask first"]')?.click();
      await vi.waitFor(() =>
        expect(
          request.mock.calls.filter(
            ([method, params]) => method === "openclaw.chat" && params?.message,
          ),
        ).toHaveLength(2),
      );
      const messages = request.mock.calls.flatMap(([method, params]) =>
        method === "openclaw.chat" ? (params?.message ?? []) : [],
      );
      expect(messages).toEqual(["Ask first", expect.stringContaining("Disk is full")]);
      expect(messages[1]).toContain("Do not retry the update");
      expect(messages[1]).not.toContain("Expected v2.0.0");
      await vi.waitFor(() => expect(surface.store.sending).toBe(false));

      status = {
        sentinel: {
          ...status.sentinel,
          ts: 4_000,
          stats: { handoffId: "queued-handoff", reason: "doctor-failed" },
        },
      };
      await overlays.refreshUpdateStatus();
      await surface.updateComplete;
      expect(overlays.snapshot.recordedUpdateAttempt?.reason).toBe("doctor-failed");
      expect(onUpdateFailure).toHaveBeenCalledTimes(2);
      expect(
        request.mock.calls.filter(
          ([method, params]) => method === "openclaw.chat" && params?.message,
        ),
      ).toHaveLength(2);
    } finally {
      overlays.dispose();
    }
  });

  it.each(["timeout", "failure"] as const)(
    "waits for campaign completion before diagnosing a verifier %s",
    async (outcome) => {
      vi.stubGlobal("sessionStorage", createStorageMock());
      const pending = {
        kind: "update",
        status: "skipped",
        ts: 2_000,
        stats: { handoffId: "applying-handoff", reason: "managed-service-handoff-started" },
      };
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
      let status: UpdateRestartStatusResponse = { sentinel: null };
      const request = vi.fn(
        async (method: string, params?: { sessionId?: string; message?: string }) => {
          if (method === "update.run") {
            status = { sentinel: pending };
            return {
              ok: true,
              handoff: { status: "started" },
              result: { status: "skipped", reason: pending.stats.reason },
              sentinel: { payload: pending },
            };
          }
          if (method === "update.status") {
            return status;
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
        vi.useFakeTimers();
        await overlays.runUpdate();
        setGatewaySnapshot({ phase: "reconnecting" });
        setGatewaySnapshot({ phase: "connected" });
        await vi.advanceTimersByTimeAsync(0);
        emitGatewayEvent({ event: "update.available", payload: { schedule } });
        status = {
          schedule,
          sentinel:
            outcome === "failure"
              ? {
                  ...pending,
                  status: "error",
                  stats: { handoffId: pending.stats.handoffId, reason: "build-failed" },
                }
              : pending,
        };
        if (outcome === "timeout") {
          vi.setSystemTime(Date.now() + 35 * 60_000);
        }
        await vi.advanceTimersByTimeAsync(1_000);
        await surface.updateComplete;
        expect(overlays.snapshot.updateReconciliationPending).toBe(false);
        expect(overlays.snapshot.updateStatusBanner?.tone).toBe("danger");
        expect(overlays.snapshot.updateRunning).toBe(true);
        expect(diagnosticMessages()).toEqual([]);

        status = { ...status, schedule: { channel: "stable", autoEnabled: true } };
        emitGatewayEvent({ event: "update.available", payload: { schedule: status.schedule } });
        await vi.advanceTimersByTimeAsync(0);
        await surface.updateComplete;
        expect(overlays.snapshot.updateRunning).toBe(false);
        expect(diagnosticMessages()).toEqual([expect.stringContaining("Do not retry the update")]);

        await overlays.refreshUpdateStatus();
        emitGatewayEvent({ event: "update.available", payload: { schedule: status.schedule } });
        setGatewaySnapshot({ phase: "reconnecting" });
        setGatewaySnapshot({ phase: "connected" });
        await vi.advanceTimersByTimeAsync(0);
        await surface.updateComplete;
        expect(diagnosticMessages()).toHaveLength(1);
      } finally {
        overlays.dispose();
        vi.useRealTimers();
      }
    },
  );

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

  it("bounds and redacts diagnostic data before it reaches the agent question", () => {
    const { context } = createContext(vi.fn());
    presentUpdateFailureTriage(
      context,
      {
        ...FAILURE,
        outcome: "unknown",
        attempt: null,
        banner: { tone: "danger", text: `token=synthetic-secret ${"x".repeat(8_000)}` },
        verification: {
          expectedVersion: "2.0.0",
          expectedSha: "3333333333333333333333333333333333333333",
          handoffId: "unknown-update-handoff",
        },
        reconciledRecord: { id: "recorded-update", timestampMs: 1_700_000_000_000 },
      },
      { isCurrent: () => true, admit: () => true },
    );

    const alert = custodianAlertStore.alert;
    expect(alert?.title).toContain("unknown update outcome");
    expect(alert?.question).toContain("2.0.0");
    expect(alert?.question).toContain("3333333333333333333333333333333333333333");
    expect(alert?.question).toContain("unknown-update-handoff");
    expect(alert?.question).toContain("recorded-update");
    expect(alert?.question).toContain("2023-11-14T22:13:20.000Z");
    expect(alert?.question).not.toContain("synthetic-secret");
    expect(alert?.question.length).toBeLessThanOrEqual(2_400);
    expect(alert?.facts.every((fact) => fact.length <= 240)).toBe(true);
  });
});
