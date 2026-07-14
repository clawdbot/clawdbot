import type { AcpRuntime, AcpRuntimeHandle } from "@openclaw/acp-core/runtime/types";
import { describe, expect, it, vi } from "vitest";
import {
  reconcileManagerRuntimeSessionIdentifiers,
  resolveOneShotResumeIdentity,
} from "./manager.identity-reconcile.js";
import type { SessionAcpMeta } from "./manager.types.js";

const handle: AcpRuntimeHandle = {
  sessionKey: "agent:claude:acp:child",
  backend: "acpx",
  runtimeSessionName: "runtime-child",
};

const meta: SessionAcpMeta = {
  backend: "acpx",
  agent: "claude",
  runtimeSessionName: "runtime-child",
  mode: "oneshot",
  state: "running",
  lastActivityAt: 1,
};

describe("manager identity reconciliation", () => {
  it("bounds a runtime status refresh", async () => {
    let statusSignal: AbortSignal | undefined;
    const runtime = {
      getStatus: vi.fn(
        async (input: { signal?: AbortSignal }) =>
          await new Promise<never>(() => {
            statusSignal = input.signal;
          }),
      ),
    } as unknown as AcpRuntime;
    const writeSessionMeta = vi.fn();

    const result = await reconcileManagerRuntimeSessionIdentifiers({
      cfg: {},
      sessionKey: handle.sessionKey,
      runtime,
      handle,
      meta,
      failOnStatusError: false,
      statusTimeoutMs: 1,
      setCachedHandle: vi.fn(),
      writeSessionMeta,
    });

    expect(result).toMatchObject({ handle, meta });
    expect(statusSignal?.aborted).toBe(true);
    expect(writeSessionMeta).not.toHaveBeenCalled();
  });

  it("requires a completed resume-capable one-shot with a stable id", () => {
    const resumableMeta: SessionAcpMeta = {
      ...meta,
      identity: {
        state: "resolved",
        source: "status",
        acpxSessionId: "acpx-session-1",
        sessionResumeSupported: true,
        lastUpdatedAt: 2,
      },
    };

    expect(resolveOneShotResumeIdentity(resumableMeta, "completed")).toEqual(
      resumableMeta.identity,
    );
    expect(resolveOneShotResumeIdentity(resumableMeta, "cancelled")).toBeUndefined();
    expect(
      resolveOneShotResumeIdentity({ ...resumableMeta, mode: "persistent" }, "completed"),
    ).toBeUndefined();
    expect(
      resolveOneShotResumeIdentity(
        {
          ...resumableMeta,
          identity: {
            state: "resolved",
            source: "status",
            acpxSessionId: "acpx-session-1",
            sessionResumeSupported: false,
            lastUpdatedAt: 2,
          },
        },
        "completed",
      ),
    ).toBeUndefined();
    expect(
      resolveOneShotResumeIdentity(
        {
          ...resumableMeta,
          identity: {
            state: "pending",
            source: "ensure",
            sessionResumeSupported: true,
            lastUpdatedAt: 2,
          },
        },
        "completed",
      ),
    ).toBeUndefined();
  });
});
