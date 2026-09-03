import type { ResolveStableChannelMessageIngressParams } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { describe, expect, it, vi } from "vitest";
import { installMSTeamsTestRuntime } from "../monitor-handler.test-helpers.js";
import { resolveMSTeamsSenderAccess } from "./access.js";

const observed = vi.hoisted(() =>
  vi.fn<(params: ResolveStableChannelMessageIngressParams) => void>(),
);
vi.mock("openclaw/plugin-sdk/channel-ingress-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/channel-ingress-runtime")>();
  return {
    ...actual,
    resolveStableChannelMessageIngress: (params: ResolveStableChannelMessageIngressParams) => {
      observed(params);
      return actual.resolveStableChannelMessageIngress(params);
    },
  };
});

describe("Teams participant domain", () => {
  it.each(["entra", "application", "unknown"] as const)(
    "retains %s identity evidence",
    async (kind) => {
      installMSTeamsTestRuntime({ readAllowFromStore: vi.fn(async () => []) });
      observed.mockClear();
      const activity = {
        type: "message",
        id: "message",
        text: "hello",
        serviceUrl: "https://fixture.invalid",
        channelId: "msteams",
        from: {
          id: "opaque-account",
          name: "Alice",
          ...(kind === "entra" ? { aadObjectId: "OBJECT-ID" } : {}),
        },
        recipient: { id: "bot", name: "Bot" },
        conversation: {
          id: "conversation",
          conversationType: "personal",
          ...(kind === "entra" ? { tenantId: "TENANT" } : {}),
        },
      };
      const result = await resolveMSTeamsSenderAccess({
        cfg: {
          channels: {
            msteams: {
              dmPolicy: "open",
              allowFrom: ["*"],
              ...(kind === "application" ? { appId: "APP" } : {}),
            },
          },
        },
        activity,
      });
      expect(result.senderAccess.allowed).toBe(true);
      const input = observed.mock.calls[0]?.[0];
      expect(input?.identity?.resolveParticipant?.(input.subject)).toEqual(
        kind === "entra"
          ? { domain: "entra:tenant", idKind: "object-id", id: "object-id" }
          : kind === "application"
            ? { domain: "bot:app", idKind: "channel-account-id", id: "opaque-account" }
            : undefined,
      );
    },
  );
});
