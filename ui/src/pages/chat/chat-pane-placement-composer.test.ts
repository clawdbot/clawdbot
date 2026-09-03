/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { resolveComposerAvailability } from "./chat-composer-availability.ts";
import { resolvePlacementComposer } from "./chat-pane-placement.ts";

function placementSession(
  state: NonNullable<GatewaySessionRow["placement"]>["state"],
  recoveryAction?: "restart" | "stop-first",
): GatewaySessionRow {
  return {
    key: "agent:main:cloud",
    kind: "direct",
    updatedAt: 0,
    placement: {
      state,
      ...(recoveryAction ? { recoveryAction } : {}),
    } as GatewaySessionRow["placement"],
  };
}

function presentation(
  row: GatewaySessionRow,
  overrides: Partial<Parameters<typeof resolvePlacementComposer>[0]> = {},
) {
  return resolvePlacementComposer({
    gatewaySnapshot: {
      hello: {
        features: { methods: ["sessions.dispatch", "sessions.reclaim"] },
        auth: { role: "operator", scopes: ["operator.read", "operator.write"] },
      },
    } as ApplicationGatewaySnapshot,
    movingKey: null,
    reclaimingKey: null,
    restartingKey: null,
    row,
    startupPending: false,
    onRestart: vi.fn(),
    onReclaim: vi.fn(),
    ...overrides,
  });
}

describe("chat placement composer presentation", () => {
  it.each([
    ["active", "ready", undefined],
    ["reclaimed", "ready", undefined],
    ["provisioning", "busy", "Provisioning environment…"],
    ["syncing", "busy", "Preparing workspace…"],
    ["starting", "busy", "Starting…"],
    ["draining", "busy", "Finishing session move…"],
    ["reconciling", "busy", "Finishing session move…"],
  ] as const)("projects %s placement into a %s composer", (state, kind, busyMessage) => {
    const result = presentation(placementSession(state));

    expect(result.state.kind).toBe(kind);
    expect(result.blocksSend).toBe(kind !== "ready");
    expect(result.busyMessage).toBe(busyMessage ?? null);
    expect(
      resolveComposerAvailability({
        catalog: false,
        catalogCanSend: false,
        catalogDisabledReason: null,
        modelSetupRequired: false,
        baseDisabledReason: null,
        baseDisabledReasonTone: "danger",
        selectedSessionArchived: false,
        restartRecoveryTombstoned: false,
        placement: result,
        sendHoldReason: null,
        placementStartupPending: false,
        sessionDisabledBanner: undefined,
      }).canSend,
    ).toBe(kind === "ready");
  });

  it.each(["restart", "stop-first"] as const)(
    "projects failed %s recovery into an actionable composer banner",
    (recoveryAction) => {
      const onRestart = vi.fn();
      const onReclaim = vi.fn();
      const result = presentation(placementSession("failed", recoveryAction), {
        onRestart,
        onReclaim,
      });

      expect(result.state).toEqual({ kind: "failed", recoveryAction });
      expect(result.blocksSend).toBe(true);
      expect(result.disabledBanner?.title).toBe("Runner failed");
      expect(result.disabledBanner?.actionLabel).toBe(
        recoveryAction === "restart" ? "Restart session…" : "Stop cloud worker…",
      );
      result.disabledBanner?.onAction();
      expect(recoveryAction === "restart" ? onRestart : onReclaim).toHaveBeenCalledOnce();
    },
  );

  it("projects local restart work ahead of the stale failed placement", () => {
    const row = placementSession("failed", "restart");
    const result = presentation(row, { restartingKey: row.key });

    expect(result.state).toEqual({ kind: "busy", message: "Restarting session…" });
    expect(result.busyMessage).toBe("Restarting session…");
    expect(result.disabledBanner).toBeUndefined();
  });
});
