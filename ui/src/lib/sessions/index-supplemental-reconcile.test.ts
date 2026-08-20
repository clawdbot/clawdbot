// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createSessionCapability } from "./index.ts";
import { createGatewayHarness, sessionsResult } from "./session-capability.test-support.ts";

const key = "agent:main:device-session";

function placement(status: "available" | "offline") {
  return {
    state: "active" as const,
    generation: 4,
    createdAtMs: 1,
    updatedAtMs: 2,
    stateChangedAtMs: 2,
    environmentId: "environment-device",
    activeOwnerEpoch: 7,
    workerBundleHash: "a".repeat(64),
    workspaceBaseManifestRef: "manifest-device",
    remoteWorkspaceDir: "/workspace",
    runner: { kind: "device" as const, status },
  };
}

function capabilityWithList(result: ReturnType<typeof sessionsResult>) {
  const request = vi.fn(async (method: string) => {
    if (method !== "sessions.list") {
      throw new Error(`Unexpected request: ${method}`);
    }
    return result;
  });
  const client = { request } as unknown as GatewayBrowserClient;
  return createSessionCapability(createGatewayHarness(client).gateway);
}

describe("supplemental session reconciliation", () => {
  it("preserves a matching canonical row when history started before its list", async () => {
    const sessions = capabilityWithList(
      sessionsResult(
        [
          {
            key,
            kind: "direct",
            sessionId: "session-device",
            updatedAt: 10,
            placement: placement("offline"),
          },
        ],
        10,
      ),
    );
    const sourceCanonicalListRevision = sessions.canonicalListRevision;

    await sessions.refresh({ force: true });
    sessions.reconcile(
      {
        key,
        kind: "direct",
        sessionId: "session-device",
        updatedAt: 10,
        placement: placement("available"),
      },
      { modelProvider: "openai", model: "gpt-5.6-luna", contextTokens: 128_000 },
      { sourceCanonicalListRevision },
    );

    expect(sessions.state.result?.sessions[0]?.placement).toMatchObject({
      runner: { kind: "device", status: "offline" },
    });
    expect(sessions.state.result?.defaults).toMatchObject({
      modelProvider: "openai",
      model: "gpt-5.6-luna",
      contextTokens: 128_000,
    });
    sessions.dispose();
  });

  it("adds a routed row absent from a newer canonical list", async () => {
    const sessions = capabilityWithList(sessionsResult([], 10));
    const sourceCanonicalListRevision = sessions.canonicalListRevision;

    await sessions.refresh({ force: true });
    sessions.reconcile(
      {
        key: "agent:main:archived-routed",
        kind: "direct",
        sessionId: "session-routed",
        updatedAt: 10,
        archived: true,
      },
      undefined,
      { archivedFilter: "all", sourceCanonicalListRevision },
    );

    expect(sessions.state.result?.sessions).toEqual([
      expect.objectContaining({
        key: "agent:main:archived-routed",
        archived: true,
        sessionId: "session-routed",
      }),
    ]);
    sessions.dispose();
  });
});
