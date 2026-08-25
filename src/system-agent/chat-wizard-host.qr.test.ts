import "./chat-engine.mocks.test-support.js";
import { describe, expect, it, vi } from "vitest";
import { createNonExitingRuntime } from "../runtime.js";
import {
  fakeOverviewLoader,
  useTempStateDir,
  SystemAgentChatEngine,
  mocks,
  type WizardPrompter,
} from "./chat-engine.test-support.js";
import { ChatWizardHost } from "./chat-wizard-host.js";

describe("SystemAgentChatEngine QR wizard", () => {
  it("projects producer-owned QR setup and records its polled terminal outcome", async () => {
    useTempStateDir();
    let finish!: (account: string) => void;
    const settled = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const engine = new SystemAgentChatEngine({
      surface: "gateway",
      supportsQrCode: true,
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
      runChannelSetupWizard: async (_channel: string, prompter: WizardPrompter) => {
        await prompter.qrCode?.({
          title: "Link Signal",
          message: "Scan this code.",
          text: "sgnl://linkdevice?credential=secret",
          settled,
        });
      },
    });

    const presented = await engine.handle("connect signal");
    expect(presented.step).toMatchObject({
      type: "qr",
      executor: "gateway",
      canCancel: true,
    });
    expect(presented.wizardInputPending).toBeUndefined();
    expect(JSON.stringify(presented)).not.toContain("credential=secret");

    finish("+15555550123");
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    const completed = await engine.decorateRejoinReply({ text: "Welcome", action: "none" });

    expect(completed.text).toContain("signal is configured");
    expect(completed.step).toBeUndefined();
    expect(engine.historySince(0)).toContainEqual({
      role: "assistant",
      text: completed.text,
    });
  });

  it("locks cancellation before a hosted channel persistent effect", async () => {
    useTempStateDir();
    let finish!: (account: string) => void;
    const settled = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const engine = new SystemAgentChatEngine({
      surface: "gateway",
      supportsQrCode: true,
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
      runChannelSetupWizard: async (
        _channel: string,
        prompter: WizardPrompter,
        beforeExternalApply,
        beforePersistentApply,
      ) => {
        await beforeExternalApply(createNonExitingRuntime());
        await beforePersistentApply(createNonExitingRuntime());
        await prompter.qrCode?.({
          title: "Link Signal",
          text: "sgnl://linkdevice?credential=secret",
          settled,
        });
      },
    });

    const presented = await engine.handle("connect signal");
    expect(presented.step).toMatchObject({ type: "qr", canCancel: false });
    await expect(engine.cancelWizard({ stepId: presented.step?.id ?? "missing" })).rejects.toThrow(
      "cannot be cancelled right now",
    );

    finish("+15555550123");
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    await engine.dispose();
  });

  it("keeps cancellation open after a hosted channel external check", async () => {
    useTempStateDir();
    let release!: () => void;
    const settled = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.readSetupConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      hash: "qr-external-base",
      config: {},
      sourceConfig: {},
    });
    mocks.setupChannels.mockImplementation(async (config, _runtime, prompter, options) => {
      await options.beforeExternalEffect?.();
      await prompter.qrCode?.({
        title: "Link Signal",
        text: "sgnl://linkdevice?credential=secret",
        settled,
      });
      return config;
    });
    const engine = new SystemAgentChatEngine({
      surface: "gateway",
      supportsQrCode: true,
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
    });

    const presented = await engine.handle("connect signal");
    expect(presented.step).toMatchObject({ type: "qr", canCancel: true });
    const cancelled = await engine.cancelWizard({ stepId: presented.step?.id ?? "missing" });
    expect(cancelled.text).toContain("setup cancelled");

    release();
    await engine.dispose();
  });

  it.each(["external", "persistent"] as const)(
    "rejects %s effects when cancellation lands during authority validation",
    async (effect) => {
      let authorityEntered!: () => void;
      const entered = new Promise<void>((resolve) => {
        authorityEntered = resolve;
      });
      let releaseAuthority!: () => void;
      const authority = new Promise<void>((resolve) => {
        releaseAuthority = resolve;
      });
      let effectReached = false;
      const host = new ChatWizardHost({
        surface: "gateway",
        supportsQrCode: true,
        beforePersistentApply: async () => {
          authorityEntered();
          await authority;
        },
        dependencies: {
          runChannelSetupWizard: async (
            _channel,
            _prompter,
            beforeExternalApply,
            beforePersistentApply,
          ) => {
            await (effect === "external" ? beforeExternalApply : beforePersistentApply)(
              createNonExitingRuntime(),
            );
            effectReached = true;
          },
        },
      });

      const start = host.startChannel("signal");
      await entered;
      host.dispose();
      releaseAuthority();
      await start;

      expect(effectReached).toBe(false);
    },
  );

  it("does not rejoin with a QR after its deadline before timer cleanup", async () => {
    useTempStateDir();
    vi.useFakeTimers();
    vi.setSystemTime(2_000);
    const engine = new SystemAgentChatEngine({
      surface: "gateway",
      supportsQrCode: true,
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
      runChannelSetupWizard: async (_channel: string, prompter: WizardPrompter) => {
        await prompter.qrCode?.({
          title: "Link Signal",
          text: "sgnl://linkdevice?credential=expired",
          expiresInMs: 100,
          settled: new Promise(() => {}),
        });
      },
    });
    try {
      const presented = await engine.handle("connect signal");
      expect(presented.step).toMatchObject({ type: "qr", expiresInMs: 100 });

      vi.setSystemTime(2_101);
      const rejoined = await engine.decorateRejoinReply({ text: "Welcome", action: "none" });
      expect(rejoined.step).toBeUndefined();
      expect(rejoined.text).toContain("QR presentation expired");
      expect(rejoined.text).toContain("restart setup to retry");
    } finally {
      vi.useRealTimers();
      await engine.dispose();
    }
  });

  it("returns a visible result when plain-text cancel reaches a locked QR", async () => {
    useTempStateDir();
    let finishLink!: (account: string) => void;
    const linked = new Promise<string>((resolve) => {
      finishLink = resolve;
    });
    let releaseCommit!: () => void;
    const commit = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const engine = new SystemAgentChatEngine({
      surface: "gateway",
      supportsQrCode: true,
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
      runChannelSetupWizard: async (_channel: string, prompter: WizardPrompter) => {
        await prompter.qrCode?.({
          title: "Link Signal",
          text: "sgnl://linkdevice?credential=secret",
          settled: linked,
        });
        await commit;
      },
    });

    const presented = await engine.handle("connect signal");
    expect(presented.step).toMatchObject({ type: "qr" });
    finishLink("+15555550123");
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    const cancel = engine.handle("cancel");
    try {
      const outcome = await Promise.race([
        cancel.then((reply) => ({ kind: "reply" as const, reply })),
        new Promise<{ kind: "pending" }>((resolve) => {
          setImmediate(() => resolve({ kind: "pending" }));
        }),
      ]);
      expect(outcome).toMatchObject({
        kind: "reply",
        reply: { text: expect.stringContaining("cannot be cancelled right now") },
      });
    } finally {
      releaseCommit();
      await cancel;
      await engine.dispose();
    }
  });

  it("disposes without waiting for locked post-link finalization", async () => {
    useTempStateDir();
    let finishLink!: (account: string) => void;
    const linked = new Promise<string>((resolve) => {
      finishLink = resolve;
    });
    let releaseFinalization!: () => void;
    const finalization = new Promise<void>((resolve) => {
      releaseFinalization = resolve;
    });
    let markFinalized!: () => void;
    const finalized = new Promise<void>((resolve) => {
      markFinalized = resolve;
    });
    const engine = new SystemAgentChatEngine({
      surface: "gateway",
      supportsQrCode: true,
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
      runChannelSetupWizard: async (_channel: string, prompter: WizardPrompter) => {
        await prompter.qrCode?.({
          title: "Link Signal",
          text: "sgnl://linkdevice?credential=secret",
          settled: linked,
        });
        await finalization;
        markFinalized();
      },
    });

    const presented = await engine.handle("connect signal");
    expect(presented.step).toMatchObject({ type: "qr" });
    finishLink("+15555550123");
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    const disposal = engine.dispose();
    try {
      const outcome = await Promise.race([
        disposal.then(() => "disposed" as const),
        new Promise<"pending">((resolve) => {
          setImmediate(() => resolve("pending"));
        }),
      ]);
      expect(outcome).toBe("disposed");
    } finally {
      releaseFinalization();
      await disposal;
      await finalized;
    }
  });
});
