import { afterEach, describe, expect, it, vi } from "vitest";
import { peekChatMetadata } from "../../lib/chat/chat-metadata-store.ts";
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";
import { patchNewSessionPreference } from "./preferences.ts";

// The closed list of gates allowed to block without a visible reason: the busy
// Start button and an empty draft explain themselves. Growing it is a product
// decision — edit this list and the matching one in submit-gates.ts together.
const SILENT_SUBMIT_GATES = ["submitting", "empty-draft"];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  localStorage.clear();
});

describe("DraftSubmissionFlow submit gates", () => {
  it.each([
    {
      reason: "missing-auth",
      message: "No provider credential is configured for this model. Set it up in Model Setup.",
    },
    {
      reason: "auth-failed",
      message: "Authentication failed. Review the provider credential or sign-in, then retry.",
    },
    { reason: "cooldown", message: undefined },
    { reason: undefined, message: undefined },
  ] as const)(
    "blocks new sessions only for actionable $reason model availability",
    async ({ reason, message }) => {
      const { context, flow, place } = createDraftFixture({
        request: async () => ({
          models: [
            {
              id: "gpt-5.6-luna",
              name: "GPT-5.6 Luna",
              provider: "openai",
              available: false,
              unavailableReason: reason,
            },
          ],
        }),
      });
      place.modelControl.load(context, "main", true, { agent: place.selectedAgent() });
      await vi.waitFor(() =>
        expect(peekChatMetadata(context.gateway.snapshot.client!, "main")?.models).toHaveLength(1),
      );
      flow.setMessage("Start this session");
      expect(flow.submitBlock()).toEqual(
        message ? { gate: "model-unavailable", reason: message } : undefined,
      );
      expect(flow.canSubmit()).toBe(message === undefined);
    },
  );

  it("keeps every blocking gate visible: canSubmit and the reason derive from one table", () => {
    const scenarios: Array<{ name: string; build: () => ReturnType<typeof createDraftFixture> }> = [
      { name: "empty draft", build: () => createDraftFixture() },
      {
        name: "gateway disconnected",
        build: () => {
          const fixture = createDraftFixture({ phase: "connecting" });
          fixture.flow.setMessage("hello");
          return fixture;
        },
      },
      {
        name: "attachment reads pending",
        build: () => {
          const fixture = createDraftFixture();
          fixture.flow.setMessage("hello");
          fixture.flow.attachmentDraft.updatePending(fixture.flow.attachmentDraft.readSignal, 1);
          return fixture;
        },
      },
      {
        name: "no agents on the gateway",
        build: () => {
          const fixture = createDraftFixture({ agents: [] });
          fixture.flow.setMessage("hello");
          return fixture;
        },
      },
      {
        name: "sessions.create not advertised",
        build: () => {
          const fixture = createDraftFixture({ methods: [] });
          fixture.flow.setMessage("hello");
          return fixture;
        },
      },
      {
        name: "submission outcome unknown",
        build: () => {
          const fixture = createDraftFixture();
          fixture.flow.setMessage("hello");
          fixture.flow.markPendingPlacementUnavailable("gateway-changed");
          return fixture;
        },
      },
    ];
    for (const scenario of scenarios) {
      const { flow } = scenario.build();
      const block = flow.submitBlock();
      expect(block, scenario.name).toBeDefined();
      expect(flow.canSubmit(), scenario.name).toBe(false);
      if (!(SILENT_SUBMIT_GATES as readonly string[]).includes(block?.gate ?? "")) {
        // A reasoned gate must explain itself, and the Start tooltip must
        // report the same first-gate reason canSubmit blocks on.
        expect(block?.reason, scenario.name).toBeTruthy();
        expect(flow.submitDisabledReason(), scenario.name).toBe(block?.reason);
      }
    }

    const ready = createDraftFixture();
    ready.flow.setMessage("hello");
    expect(ready.flow.submitBlock()).toBeUndefined();
    expect(ready.flow.canSubmit()).toBe(true);
    expect(ready.flow.submitDisabledReason()).toBeUndefined();
  });

  it("surfaces a reason for Enter during worktree preference restore, then clears it", async () => {
    patchNewSessionPreference("ws://gateway.example", "main", {
      folder: "/workspace",
      worktree: true,
    });
    let resolveBranches!: (value: unknown) => void;
    const fixture = createDraftFixture({
      scopes: ["operator.admin", "operator.read", "operator.write"],
      agents: [
        {
          id: "main",
          workspace: "/workspace",
          workspaceGit: true,
          model: { primary: "openai/gpt-5.6-luna" },
        },
      ],
      request: (method) => {
        if (method === "worktrees.branches") {
          return new Promise((resolve) => {
            resolveBranches = resolve;
          });
        }
        return Promise.resolve({});
      },
    });
    const { context, flow } = fixture;
    flow.setMessage("start something");

    // The async preference restore is still in flight: submission is gated,
    // but the gate must be visible, not a silent no-op.
    expect(flow.canSubmit()).toBe(false);
    expect(flow.submitDisabledReason()).toBeTruthy();
    expect(flow.blockedSubmitNotice()).toBeUndefined();

    await flow.submit();
    expect(context.sessions.createResult).not.toHaveBeenCalled();
    expect(flow.blockedSubmitNotice()).toBe(flow.submitDisabledReason());

    resolveBranches({ repositoryStatus: "git", branches: ["main"], defaultBranch: "main" });
    await vi.waitFor(() => expect(flow.canSubmit()).toBe(true));
    // The transient gate lifted; the notice retires itself.
    expect(flow.blockedSubmitNotice()).toBeUndefined();
    expect(flow.submitDisabledReason()).toBeUndefined();
  });

  it("does not raise a notice for the silent empty-draft gate", async () => {
    const fixture = createDraftFixture();
    await fixture.flow.submit();
    expect(fixture.flow.canSubmit()).toBe(false);
    expect(fixture.flow.submitBlock()?.gate).toBe("empty-draft");
    expect(fixture.flow.blockedSubmitNotice()).toBeUndefined();
  });

  it("blocks a retained device choice when the selected runtime cannot dispatch there", async () => {
    const fixture = createDraftFixture({
      methods: ["environments.list", "sessions.create", "sessions.dispatch"],
      scopes: ["operator.admin", "operator.read", "operator.write"],
      agents: [
        {
          id: "main",
          workspace: "/workspace",
          workspaceGit: false,
          model: { primary: "openai/gpt-5.6-sol" },
          agentRuntime: {
            id: "cloud-only",
            cloudPlacementSupported: true,
            devicePlacementSupported: false,
            source: "model",
          },
        },
      ],
      request: async (method) =>
        method === "environments.list"
          ? {
              environments: [
                {
                  id: "node:build-mac",
                  type: "node",
                  label: "Build Mac",
                  status: "available",
                  sessionHost: true,
                  workerSlots: { total: 1, available: 1 },
                },
              ],
              profiles: [],
            }
          : {},
    });
    await fixture.gateway.refreshCloudProfiles();
    await vi.waitFor(() => expect(fixture.place.devices()).toHaveLength(1));
    fixture.place.selectDevice("build-mac");
    fixture.flow.setMessage("run on the device");

    expect(fixture.flow.submitBlock()).toEqual({
      gate: "device-runtime",
      reason: "This runtime does not support paired devices",
    });
    expect(fixture.flow.canSubmit()).toBe(false);
    expect(fixture.flow.submitDisabledReason()).toBe(
      "This runtime does not support paired devices",
    );
    expect(fixture.request).not.toHaveBeenCalledWith("node.list", expect.anything());
  });
});
