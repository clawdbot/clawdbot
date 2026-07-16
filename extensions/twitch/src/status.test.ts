/**
 * Tests for status.ts module
 *
 * Tests cover:
 * - Detection of unconfigured accounts
 * - Detection of disabled accounts
 * - Detection of missing clientId
 * - Token format warnings
 * - Access control warnings
 * - Runtime error detection
 */

import { describe, expect, it } from "vitest";
import { collectTwitchStatusIssues } from "./status.js";
import type { ChannelAccountSnapshot } from "./types.js";

function createSnapshot(overrides: Partial<ChannelAccountSnapshot> = {}): ChannelAccountSnapshot {
  return {
    accountId: "default",
    configured: true,
    enabled: true,
    running: false,
    ...overrides,
  };
}

function createSimpleTwitchConfig(overrides: Record<string, unknown>) {
  return {
    channels: {
      twitch: overrides,
    },
  };
}

describe("status", () => {
  describe("collectTwitchStatusIssues", () => {
    it("should detect unconfigured accounts", () => {
      const snapshots: ChannelAccountSnapshot[] = [createSnapshot({ configured: false })];

      const issues = collectTwitchStatusIssues(snapshots);

      expect(issues.length).toBeGreaterThan(0);
      expect(issues[0]?.kind).toBe("config");
      expect(issues[0]?.message).toContain("not properly configured");
    });

    it("should detect disabled accounts", () => {
      const snapshots: ChannelAccountSnapshot[] = [createSnapshot({ enabled: false })];

      const issues = collectTwitchStatusIssues(snapshots);

      expect(issues.length).toBeGreaterThan(0);
      expect(issues).toContainEqual(
        expect.objectContaining({
          kind: "config",
          message: "Twitch account is disabled",
        }),
      );
    });

    it("should detect missing clientId when account configured (simplified config)", () => {
      const snapshots: ChannelAccountSnapshot[] = [createSnapshot()];
      const mockCfg = createSimpleTwitchConfig({
        username: "testbot",
        accessToken: "oauth:test123",
        // clientId missing
      });

      const issues = collectTwitchStatusIssues(snapshots, () => mockCfg as never);

      expect(issues).toContainEqual(
        expect.objectContaining({
          kind: "config",
          message: "Twitch client ID is required",
        }),
      );
    });

    it("should warn about oauth: prefix in token (simplified config)", () => {
      const snapshots: ChannelAccountSnapshot[] = [createSnapshot()];
      const mockCfg = createSimpleTwitchConfig({
        username: "testbot",
        accessToken: "oauth:test123", // has prefix
        clientId: "test-id",
      });

      const issues = collectTwitchStatusIssues(snapshots, () => mockCfg as never);

      expect(issues).toContainEqual(
        expect.objectContaining({
          kind: "config",
          message: "Token contains 'oauth:' prefix (will be stripped)",
        }),
      );
    });

    it("should detect clientSecret without refreshToken (simplified config)", () => {
      const snapshots: ChannelAccountSnapshot[] = [createSnapshot()];
      const mockCfg = createSimpleTwitchConfig({
        username: "testbot",
        accessToken: "oauth:test123",
        clientId: "test-id",
        clientSecret: "secret123",
        // refreshToken missing
      });

      const issues = collectTwitchStatusIssues(snapshots, () => mockCfg as never);

      expect(issues).toContainEqual(
        expect.objectContaining({
          kind: "config",
          message: "clientSecret provided without refreshToken",
        }),
      );
    });

    it("should detect empty allowFrom array (simplified config)", () => {
      const snapshots: ChannelAccountSnapshot[] = [createSnapshot()];
      const mockCfg = createSimpleTwitchConfig({
        username: "testbot",
        accessToken: "test123",
        clientId: "test-id",
        allowFrom: [], // empty array
      });

      const issues = collectTwitchStatusIssues(snapshots, () => mockCfg as never);

      expect(issues).toContainEqual(
        expect.objectContaining({
          kind: "config",
          message: "allowFrom is configured but empty",
        }),
      );
    });

    it("should detect allowedRoles 'all' with allowFrom conflict (simplified config)", () => {
      const snapshots: ChannelAccountSnapshot[] = [createSnapshot()];
      const mockCfg = createSimpleTwitchConfig({
        username: "testbot",
        accessToken: "test123",
        clientId: "test-id",
        allowedRoles: ["all"],
        allowFrom: ["123456"], // conflict!
      });

      const issues = collectTwitchStatusIssues(snapshots, () => mockCfg as never);

      expect(issues).toContainEqual(
        expect.objectContaining({
          kind: "intent",
          message: "allowedRoles is set to 'all' but allowFrom is also configured",
        }),
      );
    });

    it("should detect runtime errors", () => {
      const snapshots: ChannelAccountSnapshot[] = [
        createSnapshot({ lastError: "Connection timeout" }),
      ];

      const issues = collectTwitchStatusIssues(snapshots);

      expect(issues).toContainEqual(
        expect.objectContaining({
          kind: "runtime",
          message: "Last error: Connection timeout",
        }),
      );
    });

    it("should detect accounts that never connected", () => {
      const snapshots: ChannelAccountSnapshot[] = [
        createSnapshot({
          lastStartAt: undefined,
          lastInboundAt: undefined,
          lastOutboundAt: undefined,
        }),
      ];

      const issues = collectTwitchStatusIssues(snapshots);

      expect(issues).toContainEqual(
        expect.objectContaining({
          kind: "runtime",
          message: "Account has never connected successfully",
        }),
      );
    });

    it("should detect long-running connections", () => {
      const oldDate = Date.now() - 8 * 24 * 60 * 60 * 1000; // 8 days ago

      const snapshots: ChannelAccountSnapshot[] = [
        createSnapshot({
          running: true,
          lastStartAt: oldDate,
        }),
      ];

      const issues = collectTwitchStatusIssues(snapshots);

      expect(issues).toContainEqual(
        expect.objectContaining({
          kind: "runtime",
          message: "Connection has been running for 8 days",
        }),
      );
    });

    it("should handle empty snapshots array", () => {
      const issues = collectTwitchStatusIssues([]);

      expect(issues).toEqual([]);
    });

    it("should skip non-Twitch accounts gracefully", () => {
      const snapshots: ChannelAccountSnapshot[] = [
        {
          accountId: "unknown",
          configured: false,
          enabled: true,
          running: false,
        },
      ];

      const issues = collectTwitchStatusIssues(snapshots);

      expect(issues).toEqual([
        expect.objectContaining({
          accountId: "unknown",
          kind: "config",
          message: "Twitch account is not properly configured",
        }),
      ]);
    });
  });
});
