import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.unmock("../agents/agent-scope-config.js");

const { runSecurityAudit } = await import("./audit.js");

describe("security audit rosterless configs", () => {
  it("uses the explicit audit workspace without resolving a missing roster default", async () => {
    const workspaceDir = path.join(process.cwd(), "tmp", "audit-rosterless-workspace");

    await expect(
      runSecurityAudit({
        config: {},
        workspaceDir,
        env: {},
        includeFilesystem: false,
        includeChannelSecurity: false,
      }),
    ).resolves.toEqual(expect.objectContaining({ findings: expect.any(Array) }));
  });
});
