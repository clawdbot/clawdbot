import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  analyzeHeartbeatTemplateForRepair,
  maybeRepairHeartbeatTemplate,
} from "./doctor-heartbeat-template-repair.js";

const mocks = vi.hoisted(() => ({
  note: vi.fn(),
}));

vi.mock("../terminal/note.js", () => ({
  note: mocks.note,
}));

const tempDirs: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-heartbeat-template-"));
  tempDirs.push(root);
  return root;
}

async function makeWorkspaceWithHeartbeat(content: string): Promise<{
  workspaceDir: string;
  heartbeatPath: string;
}> {
  const workspaceDir = await makeTempRoot();
  const heartbeatPath = path.join(workspaceDir, "HEARTBEAT.md");
  await fs.writeFile(heartbeatPath, content, "utf-8");
  return { workspaceDir, heartbeatPath };
}

describe("heartbeat template repair", () => {
  afterEach(async () => {
    mocks.note.mockReset();
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("recognizes the original prose docs-backed template as repairable", () => {
    const analysis = analyzeHeartbeatTemplateForRepair(`# HEARTBEAT.md

Keep this file empty unless you want a tiny checklist. Keep it small.
`);

    expect(analysis.status).toBe("dirty-template");
  });

  it("keeps original prose templates with user tasks unchanged", async () => {
    const { workspaceDir, heartbeatPath } = await makeWorkspaceWithHeartbeat(`# HEARTBEAT.md

Keep this file empty unless you want a tiny checklist. Keep it small.

- Check email
`);

    await maybeRepairHeartbeatTemplate({
      cfg: { agents: { defaults: { workspace: workspaceDir } } },
      shouldRepair: true,
    });

    await expect(fs.readFile(heartbeatPath, "utf-8")).resolves.toContain("- Check email");
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("custom or unrecognized content"),
      "Heartbeat template",
    );
  });

  it("recognizes the docs-backed heading plus fenced template as repairable", () => {
    const analysis = analyzeHeartbeatTemplateForRepair(`# HEARTBEAT.md Template

\`\`\`markdown
# Keep this file empty (or with only comments) to skip heartbeat API calls.

# Add tasks below when you want the agent to check something periodically.
\`\`\`
`);

    expect(analysis.status).toBe("dirty-template");
  });

  it("recognizes the fenced docs-backed template as repairable", () => {
    const analysis = analyzeHeartbeatTemplateForRepair(`\`\`\`markdown
# Keep this file empty (or with only comments) to skip heartbeat API calls.

# Add tasks below when you want the agent to check something periodically.
\`\`\`
`);

    expect(analysis.status).toBe("dirty-template");
  });

  it("recognizes the original docs-backed template as repairable", () => {
    const analysis = analyzeHeartbeatTemplateForRepair(`\`\`\`markdown
# Keep this file empty (or with only comments) to skip heartbeat API calls.

# Add tasks below when you want the agent to check something periodically.
\`\`\`

## Related

- [Heartbeat config](/gateway/config-agents)
`);

    expect(analysis.status).toBe("dirty-template");
  });

  it("recognizes the current docs page boilerplate template as repairable", () => {
    const analysis = analyzeHeartbeatTemplateForRepair(`# HEARTBEAT.md template

\`HEARTBEAT.md\` lives in the agent workspace. Keep the file empty, or with only Markdown comments and headings, when you want OpenClaw to skip heartbeat model calls.

The default runtime template is:

\`\`\`markdown
# Keep this file empty (or with only comments) to skip heartbeat API calls.

# Add tasks below when you want the agent to check something periodically.
\`\`\`

Add short tasks below the comments only when you want the agent to check something periodically. Keep heartbeat instructions small because they are read during recurring wakes.

## Related

- [Heartbeat config](/gateway/config-agents)
`);

    expect(analysis.status).toBe("dirty-template");
  });

  it("ignores user-authored fenced content without the old template body", () => {
    const analysis = analyzeHeartbeatTemplateForRepair(`tasks:
  - name: status
    prompt: |
      \`\`\`yaml
      ok: true
      \`\`\`
`);

    expect(analysis.status).toBe("clean");
  });

  it("keeps dirty templates with user tasks unchanged", async () => {
    const { workspaceDir, heartbeatPath } = await makeWorkspaceWithHeartbeat(`\`\`\`markdown
# Keep this file empty (or with only comments) to skip heartbeat API calls.

# Add tasks below when you want the agent to check something periodically.
\`\`\`

- Check email
`);

    await maybeRepairHeartbeatTemplate({
      cfg: { agents: { defaults: { workspace: workspaceDir } } },
      shouldRepair: true,
    });

    await expect(fs.readFile(heartbeatPath, "utf-8")).resolves.toContain("- Check email");
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("custom or unrecognized content"),
      "Heartbeat template",
    );
  });

  it("keeps unrecognized dirty template shapes unchanged", async () => {
    const content = `# HEARTBEAT.md Template

\`\`\`markdown
# Add tasks below when you want the agent to check something periodically.

# Keep this file empty (or with only comments) to skip heartbeat API calls.
\`\`\`
`;
    const { workspaceDir, heartbeatPath } = await makeWorkspaceWithHeartbeat(content);

    await maybeRepairHeartbeatTemplate({
      cfg: { agents: { defaults: { workspace: workspaceDir } } },
      shouldRepair: true,
    });

    await expect(fs.readFile(heartbeatPath, "utf-8")).resolves.toBe(content);
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("custom or unrecognized content"),
      "Heartbeat template",
    );
  });

  it("rewrites pure dirty templates to the clean runtime template", async () => {
    const { workspaceDir, heartbeatPath } = await makeWorkspaceWithHeartbeat(`\`\`\`markdown
# Keep this file empty (or with only comments) to skip heartbeat API calls.

# Add tasks below when you want the agent to check something periodically.
\`\`\`

## Related

- [Heartbeat config](/gateway/config-agents)
`);

    await maybeRepairHeartbeatTemplate({
      cfg: { agents: { defaults: { workspace: workspaceDir } } },
      shouldRepair: true,
    });

    await expect(fs.readFile(heartbeatPath, "utf-8")).resolves.toBe(
      `${[
        "# Keep this file empty (or with only comments) to skip heartbeat API calls.",
        "",
        "# Add tasks below when you want the agent to check something periodically.",
      ].join("\n")}\n`,
    );
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("clean heartbeat template"),
      "Doctor changes",
    );
  });
});
