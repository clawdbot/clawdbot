import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectHeartbeatTemplateHealthFindings,
  maybeRepairHeartbeatTemplate,
} from "./doctor-heartbeat-template-repair.js";

const mocks = vi.hoisted(() => ({
  note: vi.fn(),
}));

vi.mock("../../packages/terminal-core/src/note.js", () => ({
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

async function collectFindingsForContent(content: string) {
  return collectHeartbeatTemplateHealthFindings(
    { agents: { defaults: { workspace: "/tmp/openclaw-heartbeat-template-test" } } },
    { readFile: async () => content },
  );
}

describe("heartbeat template repair", () => {
  afterEach(async () => {
    mocks.note.mockReset();
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("recognizes the original prose docs-backed template as repairable", async () => {
    const findings = await collectFindingsForContent(`# HEARTBEAT.md

Keep this file empty unless you want a tiny checklist. Keep it small.
`);

    expect(findings).toEqual([expect.objectContaining({ requirement: "legacy-template" })]);
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

  it("recognizes the docs-backed heading plus fenced template as repairable", async () => {
    const findings = await collectFindingsForContent(`# HEARTBEAT.md Template

\`\`\`markdown
# Keep this file empty (or with only comments) to skip heartbeat API calls.

# Add tasks below when you want the agent to check something periodically.
\`\`\`
`);

    expect(findings).toEqual([expect.objectContaining({ requirement: "legacy-template" })]);
  });

  it("recognizes the fenced docs-backed template as repairable", async () => {
    const findings = await collectFindingsForContent(`\`\`\`markdown
# Keep this file empty (or with only comments) to skip heartbeat API calls.

# Add tasks below when you want the agent to check something periodically.
\`\`\`
`);

    expect(findings).toEqual([expect.objectContaining({ requirement: "legacy-template" })]);
  });

  it("recognizes the original docs-backed template as repairable", async () => {
    const findings = await collectFindingsForContent(`\`\`\`markdown
# Keep this file empty (or with only comments) to skip heartbeat API calls.

# Add tasks below when you want the agent to check something periodically.
\`\`\`

## Related

- [Heartbeat config](/gateway/config-agents)
`);

    expect(findings).toEqual([expect.objectContaining({ requirement: "legacy-template" })]);
  });

  it("recognizes the current docs page boilerplate template as repairable", async () => {
    const findings = await collectFindingsForContent(`# HEARTBEAT.md template

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

    expect(findings).toEqual([expect.objectContaining({ requirement: "legacy-template" })]);
  });

  it("ignores user-authored fenced content without the old template body", async () => {
    const findings = await collectFindingsForContent(`tasks:
  - name: status
    prompt: |
      \`\`\`yaml
      ok: true
      \`\`\`
`);

    expect(findings).toEqual([]);
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

  it("collects a finding for pure dirty templates", async () => {
    const { workspaceDir, heartbeatPath } = await makeWorkspaceWithHeartbeat(`\`\`\`markdown
# Keep this file empty (or with only comments) to skip heartbeat API calls.

# Add tasks below when you want the agent to check something periodically.
\`\`\`
`);

    const findings = await collectHeartbeatTemplateHealthFindings({
      agents: { defaults: { workspace: workspaceDir } },
    });

    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "core/doctor/heartbeat-template",
        severity: "warning",
        path: heartbeatPath,
        requirement: "legacy-template",
        fixHint: expect.stringContaining("openclaw doctor --fix"),
      }),
    ]);
  });

  it("collects a manual finding when dirty templates include user content", async () => {
    const { workspaceDir, heartbeatPath } = await makeWorkspaceWithHeartbeat(`\`\`\`markdown
# Keep this file empty (or with only comments) to skip heartbeat API calls.

# Add tasks below when you want the agent to check something periodically.
\`\`\`

- Check email
`);

    const findings = await collectHeartbeatTemplateHealthFindings({
      agents: { defaults: { workspace: workspaceDir } },
    });

    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "core/doctor/heartbeat-template",
        severity: "warning",
        path: heartbeatPath,
        requirement: "legacy-template-with-custom-content",
        fixHint: expect.stringContaining("Remove the fenced template"),
      }),
    ]);
  });

  it("returns no findings for clean templates or missing heartbeat files", async () => {
    const { workspaceDir } = await makeWorkspaceWithHeartbeat(`# Keep this file empty.
`);
    const missingWorkspaceDir = await makeTempRoot();

    await expect(
      collectHeartbeatTemplateHealthFindings({
        agents: { defaults: { workspace: workspaceDir } },
      }),
    ).resolves.toEqual([]);
    await expect(
      collectHeartbeatTemplateHealthFindings({
        agents: { defaults: { workspace: missingWorkspaceDir } },
      }),
    ).resolves.toEqual([]);
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

    const cleanTemplate = await fs.readFile(
      path.resolve("src", "agents", "templates", "HEARTBEAT.md"),
      "utf-8",
    );
    await expect(fs.readFile(heartbeatPath, "utf-8")).resolves.toBe(cleanTemplate);
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("clean heartbeat template"),
      "Doctor changes",
    );
  });
});
