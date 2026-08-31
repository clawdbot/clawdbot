// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS,
  createConfigCapabilityHarness,
  createConfigServerMock,
  deferred,
} from "./config-test-harness.ts";

const originalRaw = '{ "tools": { "exec": { "node": "original" } } }\n';
const nodePath = ["tools", "exec", "node"];
const nodeConfig = (node: string) => ({ tools: { exec: { node } } });
const rawForNode = (node: string) => `${JSON.stringify(nodeConfig(node), null, 2)}\n`;

function createRecoveryHarness(
  outcome: "own" | "uncommitted" | "foreign" = "own",
  initialRaw = originalRaw,
) {
  let storedRaw = initialRaw;
  let hash = "before";
  let getCount = 0;
  const firstAck = deferred<unknown>();
  const recoveryRead = deferred<void>();
  const submissions: Array<{ raw: string; baseHash: string }> = [];
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "config.get") {
      const config = JSON.parse(storedRaw) as Record<string, unknown>;
      const snapshot = {
        config,
        sourceConfig: config,
        raw: storedRaw,
        hash,
        configRevisionHash: hash,
        appliedConfigHash: "before",
        valid: true,
        issues: [],
      };
      if (++getCount === 2) {
        await recoveryRead.promise;
      }
      return snapshot;
    }
    if (method !== "config.set") {
      return {};
    }
    const submission = params as { raw: string; baseHash: string };
    submissions.push(submission);
    if (submission.baseHash !== hash) {
      throw new Error("config changed since last load; re-run config.get and retry");
    }
    if (submissions.length === 1) {
      if (outcome !== "uncommitted") {
        storedRaw = submission.raw;
        hash = "own-commit";
      }
      return firstAck.promise;
    }
    storedRaw = submission.raw;
    hash = "explicit-save";
    return { hash };
  });
  const { runtimeConfig, publish } = createConfigCapabilityHarness(
    request as GatewayBrowserClient["request"],
  );
  return {
    runtimeConfig,
    submissions,
    get storedRaw() {
      return storedRaw;
    },
    async start(edit = () => runtimeConfig.patchForm(nodePath, "submitted")) {
      await runtimeConfig.ensureLoaded();
      edit();
      await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
      expect(submissions).toHaveLength(1);
      expect(submissions[0]?.baseHash).toBe("before");
    },
    async reconnect(duringLoad?: () => void) {
      if (outcome === "foreign") {
        storedRaw = rawForNode("foreign");
        hash = "foreign";
      }
      // The transport rejects pending requests before publishing socket close.
      firstAck.reject(new Error("socket closed"));
      publish(false);
      publish(true);
      expect(getCount).toBe(2);
      expect(runtimeConfig.state.configLoading).toBe(true);
      duringLoad?.();
      recoveryRead.resolve();
      await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 2);
      expect(runtimeConfig.state.configLoading).toBe(false);
      expect(submissions).toHaveLength(1);
    },
    dispose() {
      runtimeConfig.setWritesSuspended(true);
      runtimeConfig.dispose();
      recoveryRead.resolve();
      firstAck.resolve({});
    },
  };
}

describe("config write recovery", () => {
  it("retains pending plugin allowlist ownership without removing authored entries", async () => {
    vi.useFakeTimers();
    const harness = createRecoveryHarness(
      "own",
      JSON.stringify({ plugins: { allow: ["authored"], entries: {} } }),
    );
    const { runtimeConfig, submissions } = harness;
    try {
      await harness.start(() =>
        runtimeConfig.patchForm(["plugins", "entries", "first", "enabled"], true),
      );
      runtimeConfig.patchForm(["plugins", "entries", "pending", "enabled"], true);
      await harness.reconnect();
      runtimeConfig.patchForm(["plugins", "entries", "pending", "enabled"], false);
      runtimeConfig.patchForm(["plugins", "entries", "authored", "enabled"], false);
      expect(runtimeConfig.state.configForm?.plugins).toEqual({
        allow: ["authored", "first"],
        entries: {
          first: { enabled: true },
          pending: { enabled: false },
          authored: { enabled: false },
        },
      });
      await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 2);
      expect(submissions).toHaveLength(1);
      await expect(runtimeConfig.save()).resolves.toBe(true);
      expect(JSON.parse(harness.storedRaw).plugins.allow).toEqual(["authored", "first"]);
      expect(submissions[1]?.baseHash).toBe("own-commit");
    } finally {
      harness.dispose();
    }
  });

  it.each([
    { mode: "raw", edit: "revert", next: "raw" },
    { mode: "form", edit: "revert", next: "form" },
    { mode: "raw", edit: "newer", next: "raw" },
    { mode: "form", edit: "newer", next: "form" },
    { mode: "raw", edit: "revert", next: "form" },
    { mode: "raw", edit: "newer", next: "form" },
  ] as const)(
    "retains a $mode $edit before a subsequent $next edit",
    async ({ mode, edit, next }) => {
      vi.useFakeTimers();
      const harness = createRecoveryHarness();
      const { runtimeConfig, submissions } = harness;
      try {
        await harness.start();
        const node = edit === "revert" ? "original" : "newer";
        const pendingRaw = edit === "revert" ? originalRaw : `${rawForNode(node)}\n`;
        if (mode === "raw") {
          runtimeConfig.setRaw(pendingRaw);
        } else {
          runtimeConfig.patchForm(nodePath, node);
        }
        expect(runtimeConfig.state.configFormDirty).toBe(edit !== "revert");

        await harness.reconnect();
        expect(runtimeConfig.state.configFormMode).toBe(mode);
        expect(JSON.parse(runtimeConfig.state.configRaw)).toEqual(nodeConfig(node));
        if (mode === "raw") {
          expect(runtimeConfig.state.configRaw).toBe(pendingRaw);
          expect(runtimeConfig.state.configAutoSaveStatus).toBe("idle");
        } else {
          expect(runtimeConfig.state.configAutoSaveStatus).toBe("paused");
        }
        expect(runtimeConfig.state.configFormDirty).toBe(true);
        expect(runtimeConfig.state.configRawOriginal).toBe(rawForNode("submitted"));
        expect(runtimeConfig.state.configFormOriginal).toEqual(nodeConfig("submitted"));
        expect(runtimeConfig.state.configDraftBaseHash).toBe("own-commit");
        expect(runtimeConfig.state.configNeedsApply).toBe(true);

        // The pre-write document is now a real edit, not a clean revert to stale originals.
        if (next === "raw") {
          runtimeConfig.setRaw(originalRaw);
        } else {
          if (mode === "raw") {
            runtimeConfig.setRaw(`${pendingRaw}\n`);
          }
          runtimeConfig.patchForm(nodePath, "original");
        }
        expect(runtimeConfig.state.configFormDirty).toBe(true);
        expect(runtimeConfig.state.configAutoSaveStatus).toBe(next === "form" ? "paused" : "idle");
        await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 2);
        expect(submissions).toHaveLength(1);
        await expect(runtimeConfig.save()).resolves.toBe(true);
        expect(submissions[1]).toEqual({
          raw: next === "raw" ? originalRaw : rawForNode("original"),
          baseHash: "own-commit",
        });
        expect(JSON.parse(harness.storedRaw)).toEqual(nodeConfig("original"));
        expect(runtimeConfig.state.configFormDirty).toBe(false);
        expect(runtimeConfig.state.configAutoSaveStatus).toBe("saved");
      } finally {
        harness.dispose();
      }
    },
  );

  it.each([false, true])(
    "keeps a raw-first draft paused after reconnect (rejected form edit: %s)",
    async (rejectFormEdit) => {
      vi.useFakeTimers();
      const server = createConfigServerMock();
      const { runtimeConfig, publish } = createConfigCapabilityHarness(
        server.request as GatewayBrowserClient["request"],
      );
      try {
        await runtimeConfig.ensureLoaded();
        runtimeConfig.setRaw('{"count":2}');
        publish(false);
        publish(true);
        await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 2);
        expect(runtimeConfig.state.configAutoSaveStatus).toBe("idle");
        expect(server.submissions).toHaveLength(0);
        if (rejectFormEdit) {
          runtimeConfig.setRaw("{");
          runtimeConfig.patchForm(["count"], 3);
          expect(runtimeConfig.state.configFormMode).toBe("raw");
          expect(runtimeConfig.state.configAutoSaveStatus).toBe("error");
          expect(runtimeConfig.state.configRaw).toBe("{");
        }
        runtimeConfig.setRaw('{"count":2}\n');
        runtimeConfig.patchForm(["count"], 3);
        expect.soft(runtimeConfig.state.configAutoSaveStatus).toBe("paused");
        await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 2);
        expect(server.submissions).toHaveLength(0);
        await expect(runtimeConfig.save()).resolves.toBe(true);
        expect(server.submissions).toEqual([
          { method: "config.set", raw: '{\n  "count": 3\n}\n', baseHash: "hash-1" },
        ]);
        runtimeConfig.patchForm(["count"], 4);
        await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
        expect(server.submissions[1]).toEqual({
          method: "config.set",
          raw: '{\n  "count": 4\n}\n',
          baseHash: "hash-2",
        });
      } finally {
        runtimeConfig.setWritesSuspended(true);
        runtimeConfig.dispose();
      }
    },
  );

  it("retains a Devices binding reverted while the recovery read is pending", async () => {
    vi.useFakeTimers();
    const harness = createRecoveryHarness();
    const { runtimeConfig, submissions } = harness;
    try {
      await harness.start();
      runtimeConfig.patchForm(nodePath, "newer");
      await harness.reconnect(() => {
        // Devices binding controls remain enabled while config.get is loading.
        expect(runtimeConfig.canSet).toBe(true);
        expect(runtimeConfig.state.configSaving).toBe(false);
        runtimeConfig.patchForm(nodePath, "original");
        expect(runtimeConfig.state.configFormDirty).toBe(false);
      });
      expect(runtimeConfig.state.configForm).toEqual(nodeConfig("original"));
      expect(runtimeConfig.state.configFormDirty).toBe(true);
      expect(runtimeConfig.state.configAutoSaveStatus).toBe("paused");
      expect(runtimeConfig.state.configRawOriginal).toBe(rawForNode("submitted"));
      expect(runtimeConfig.state.configDraftBaseHash).toBe("own-commit");
      await expect(runtimeConfig.save()).resolves.toBe(true);
      expect(submissions[1]).toEqual({ raw: rawForNode("original"), baseHash: "own-commit" });
      expect(JSON.parse(harness.storedRaw)).toEqual(nodeConfig("original"));
    } finally {
      harness.dispose();
    }
  });

  it.each(["raw", "form"] as const)(
    "never rebases a %s draft onto a foreign write",
    async (mode) => {
      vi.useFakeTimers();
      const harness = createRecoveryHarness("foreign");
      const { runtimeConfig } = harness;
      try {
        await harness.start();
        if (mode === "raw") {
          runtimeConfig.setRaw(`${rawForNode("newer")}\n`);
        } else {
          runtimeConfig.patchForm(nodePath, "newer");
        }
        await harness.reconnect();
        expect(runtimeConfig.state.configDraftBaseHash).toBe("before");
        expect(runtimeConfig.state.configRawOriginal).toBe(originalRaw);
        expect(JSON.parse(runtimeConfig.state.configRaw)).toEqual(nodeConfig("newer"));
        await expect(runtimeConfig.save()).resolves.toBe(false);
        expect(harness.storedRaw).toBe(rawForNode("foreign"));
        expect(runtimeConfig.state.configAutoSaveStatus).toBe("conflict");
      } finally {
        harness.dispose();
      }
    },
  );

  it.each(["own", "uncommitted"] as const)(
    "leaves a matching %s document clean",
    async (outcome) => {
      vi.useFakeTimers();
      const harness = createRecoveryHarness(outcome);
      const { runtimeConfig } = harness;
      try {
        await harness.start();
        if (outcome === "uncommitted") {
          runtimeConfig.setRaw(originalRaw);
        }
        await harness.reconnect();
        expect(runtimeConfig.state.configFormDirty).toBe(false);
        expect(runtimeConfig.state.configRaw).toBe(harness.storedRaw);
        expect(runtimeConfig.state.configRawOriginal).toBe(harness.storedRaw);
        expect(runtimeConfig.state.configDraftBaseHash).toBe(
          outcome === "own" ? "own-commit" : "before",
        );
        expect(runtimeConfig.state.configAutoSaveStatus).toBe("idle");
      } finally {
        harness.dispose();
      }
    },
  );
});
