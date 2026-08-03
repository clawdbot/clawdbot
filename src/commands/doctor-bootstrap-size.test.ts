// Doctor bootstrap-size tests cover prompt-context budget warnings and note rendering.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const note = vi.hoisted(() => vi.fn());
const resolveAgentWorkspaceDir = vi.hoisted(() =>
  vi.fn<(_cfg: OpenClawConfig, agentId: string) => string>(() => "/tmp/workspace"),
);
const resolveDefaultAgentId = vi.hoisted(() => vi.fn(() => "main"));
const listAgentIds = vi.hoisted(() => vi.fn(() => ["main"]));
const resolveBootstrapContextForRun = vi.hoisted(() => vi.fn());
const resolveBootstrapMaxChars = vi.hoisted(() => vi.fn(() => 20_000));
const resolveBootstrapTotalMaxChars = vi.hoisted(() => vi.fn(() => 150_000));

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note,
}));

vi.mock("../agents/agent-scope.js", () => ({
  listAgentIds,
  resolveAgentWorkspaceDir,
  tryResolveDefaultAgentId: resolveDefaultAgentId,
}));

vi.mock("../agents/bootstrap-files.js", () => ({
  resolveBootstrapContextForRun,
}));

vi.mock("../agents/embedded-agent-helpers.js", () => ({
  resolveBootstrapMaxChars,
  resolveBootstrapTotalMaxChars,
}));

import { noteBootstrapFileSize } from "./doctor-bootstrap-size.js";

describe("noteBootstrapFileSize", () => {
  beforeEach(() => {
    note.mockClear();
    resolveBootstrapContextForRun.mockReset();
    resolveBootstrapContextForRun.mockResolvedValue({
      bootstrapFiles: [],
      contextFiles: [],
    });
    listAgentIds.mockReturnValue(["main"]);
  });

  it("emits a warning when bootstrap files are truncated", async () => {
    resolveBootstrapContextForRun.mockResolvedValue({
      bootstrapFiles: [
        {
          name: "AGENTS.md",
          path: "/tmp/workspace/AGENTS.md",
          content: "a".repeat(25_000),
          missing: false,
        },
      ],
      contextFiles: [{ path: "/tmp/workspace/AGENTS.md", content: "a".repeat(20_000) }],
    });
    await noteBootstrapFileSize({} as OpenClawConfig);
    expect(note).toHaveBeenCalledTimes(1);
    const [message, title] = note.mock.calls[0] ?? [];
    expect(title).toBe("Bootstrap file size");
    expect(message).toBe(
      [
        "Workspace bootstrap files exceed limits and will be truncated:",
        "- AGENTS.md: 25,000 raw / 20,000 injected (20% truncated; max/file)",
        "Total bootstrap injected chars: 20,000 (13% of max/total 150,000).",
        "Total bootstrap raw chars (before truncation): 25,000.",
        "",
        "- Tip: tune `agents.entries.*.bootstrapMaxChars` for this agent, or `agents.defaults.bootstrapMaxChars` as fallback, for per-file limits.",
      ].join("\n"),
    );
  });

  it("threads the default agent id through bootstrap size resolution", async () => {
    resolveDefaultAgentId.mockReturnValueOnce("custom-agent");
    listAgentIds.mockReturnValueOnce(["custom-agent"]);
    resolveBootstrapContextForRun.mockResolvedValue({
      bootstrapFiles: [],
      contextFiles: [],
    });
    await noteBootstrapFileSize({} as OpenClawConfig);
    expect(resolveBootstrapMaxChars).toHaveBeenCalledWith(expect.anything(), "custom-agent");
    expect(resolveBootstrapTotalMaxChars).toHaveBeenCalledWith(expect.anything(), "custom-agent");
    expect(resolveBootstrapContextForRun).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "custom-agent" }),
    );
  });

  it("stays silent when files are comfortably within limits", async () => {
    resolveBootstrapContextForRun.mockResolvedValue({
      bootstrapFiles: [
        {
          name: "AGENTS.md",
          path: "/tmp/workspace/AGENTS.md",
          content: "a".repeat(1_000),
          missing: false,
        },
      ],
      contextFiles: [{ path: "/tmp/workspace/AGENTS.md", content: "a".repeat(1_000) }],
    });
    await noteBootstrapFileSize({} as OpenClawConfig);
    expect(note).not.toHaveBeenCalled();
  });

  it("labels a secondary agent whose bootstrap files exceed the limit", async () => {
    listAgentIds.mockReturnValue(["main", "secondary"]);
    resolveAgentWorkspaceDir.mockImplementation((_cfg, agentId) => `/tmp/${agentId}`);
    resolveBootstrapContextForRun.mockImplementation(async ({ agentId }) => ({
      bootstrapFiles:
        agentId === "secondary"
          ? [
              {
                name: "AGENTS.md",
                path: "/tmp/secondary/AGENTS.md",
                content: "a".repeat(25_000),
                missing: false,
              },
            ]
          : [],
      contextFiles:
        agentId === "secondary"
          ? [{ path: "/tmp/secondary/AGENTS.md", content: "a".repeat(20_000) }]
          : [],
    }));

    await noteBootstrapFileSize({} as OpenClawConfig);

    expect(note).toHaveBeenCalledTimes(1);
    expect(note.mock.calls[0]?.[0]).toContain('Agent "secondary":');
    expect(resolveBootstrapContextForRun).toHaveBeenCalledTimes(2);
  });
});
