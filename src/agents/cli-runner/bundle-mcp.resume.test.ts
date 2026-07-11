/** Tests bundle-MCP resume hash stability across loopback endpoint changes. */
import { describe, expect, it } from "vitest";
import { buildCrestodianToolsMcpServerConfig } from "../../mcp/openclaw-tools-serve-config.js";
import { resolveCliSessionReuse } from "../cli-session.js";
import { prepareCliBundleMcpConfig } from "./bundle-mcp.js";
import {
  cliBundleMcpHarness,
  prepareBundleProbeCliConfig,
  setupCliBundleMcpTestHarness,
} from "./bundle-mcp.test-support.js";

setupCliBundleMcpTestHarness();

describe("prepareCliBundleMcpConfig resume hash", () => {
  it("stabilizes the resume hash when only the OpenClaw loopback port changes", async () => {
    // Loopback ports are volatile per gateway run and should not force CLI
    // session abandonment when stable MCP semantics are unchanged.
    const first = await prepareBundleProbeCliConfig({
      additionalConfig: {
        mcpServers: {
          openclaw: {
            type: "http",
            url: "http://127.0.0.1:23119/mcp",
            headers: {
              Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
            },
          },
        },
      },
    });
    const second = await prepareBundleProbeCliConfig({
      additionalConfig: {
        mcpServers: {
          openclaw: {
            type: "http",
            url: "http://127.0.0.1:24567/mcp",
            headers: {
              Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
            },
          },
        },
      },
    });

    expect(first.mcpConfigHash).not.toBe(second.mcpConfigHash);
    expect(first.mcpResumeHash).toBe(second.mcpResumeHash);

    await first.cleanup?.();
    await second.cleanup?.();
  });

  it("changes the resume hash when stable MCP semantics change", async () => {
    const first = await prepareBundleProbeCliConfig({
      additionalConfig: {
        mcpServers: {
          openclaw: {
            type: "http",
            url: "http://127.0.0.1:23119/mcp",
            headers: {
              Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
            },
          },
        },
      },
    });
    const second = await prepareBundleProbeCliConfig({
      additionalConfig: {
        mcpServers: {
          openclaw: {
            type: "http",
            url: "http://127.0.0.1:23119/other",
            headers: {
              Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
            },
          },
        },
      },
    });

    expect(first.mcpResumeHash).not.toBe(second.mcpResumeHash);

    await first.cleanup?.();
    await second.cleanup?.();
  });

  it("keeps Crestodian approval state out of the resume identity", async () => {
    const prepare = async (options: Parameters<typeof buildCrestodianToolsMcpServerConfig>[0]) =>
      await prepareCliBundleMcpConfig({
        enabled: true,
        mode: "claude-config-file",
        backend: { command: "node", args: ["./fake-claude.mjs"] },
        workspaceDir: cliBundleMcpHarness.bundleProbeWorkspaceDir,
        exclusiveConfig: buildCrestodianToolsMcpServerConfig(options),
      });
    const proposed = "proposal-sha256";
    const first = await prepare({ surface: "cli", proposalRef: {} });
    const approval = await prepare({
      surface: "cli",
      approvalArmed: true,
      proposalRef: { current: proposed },
    });
    const otherSurface = await prepare({
      surface: "gateway",
      approvalArmed: true,
      proposalRef: { current: proposed },
    });

    expect(first.mcpConfigHash).not.toBe(approval.mcpConfigHash);
    expect(first.mcpResumeHash).toBe(approval.mcpResumeHash);
    expect(approval.mcpResumeHash).not.toBe(otherSurface.mcpResumeHash);
    const binding = {
      sessionId: "native-cli-session",
      authProfileId: "claude-cli:ops",
      authEpoch: "auth-epoch",
      authEpochVersion: 1,
      cwdHash: "cwd-hash",
      mcpConfigHash: first.mcpConfigHash,
      mcpResumeHash: first.mcpResumeHash,
    };
    const reuseParams = {
      binding,
      authProfileId: binding.authProfileId,
      authEpoch: binding.authEpoch,
      authEpochVersion: binding.authEpochVersion,
      cwdHash: binding.cwdHash,
      mcpConfigHash: approval.mcpConfigHash,
      mcpResumeHash: approval.mcpResumeHash,
    };
    expect(resolveCliSessionReuse(reuseParams)).toEqual({
      mode: "reuse",
      sessionId: binding.sessionId,
    });
    expect(resolveCliSessionReuse({ ...reuseParams, authEpoch: "rotated-auth-epoch" })).toEqual({
      mode: "invalidate",
      invalidatedReason: "auth-epoch",
    });
    expect(resolveCliSessionReuse({ ...reuseParams, cwdHash: "other-cwd" })).toEqual({
      mode: "invalidate",
      invalidatedReason: "cwd",
    });

    await first.cleanup?.();
    await approval.cleanup?.();
    await otherSurface.cleanup?.();
  });
});
