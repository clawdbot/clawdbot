// Copilot tests cover workspace bootstrap plugin behavior.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentHarnessAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveCopilotWorkspaceBootstrapContext } from "./workspace-bootstrap.js";

function makeAttempt(
  overrides: Partial<AgentHarnessAttemptParams> = {},
): AgentHarnessAttemptParams {
  return {
    agentId: "agent-1",
    prompt: "hello",
    runId: "run-1",
    sessionFile: "session.json",
    sessionId: "session-1",
    timeoutMs: 5000,
    workspaceDir: "C:\\workspace",
    ...overrides,
  } as unknown as AgentHarnessAttemptParams;
}

describe("resolveCopilotWorkspaceBootstrapContext", () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(path.join(tmpdir(), "copilot-bootstrap-"));
  });

  afterEach(async () => {
    await rm(workspaceDir, { force: true, recursive: true });
  });

  it("returns empty result and undefined instructions when workspaceDir is missing", async () => {
    const result = await resolveCopilotWorkspaceBootstrapContext({
      attempt: makeAttempt({ workspaceDir: undefined }),
      effectiveWorkspaceDir: undefined,
    });
    expect(result.bootstrapFiles).toEqual([]);
    expect(result.contextFiles).toEqual([]);
    expect(result.instructions).toBeUndefined();
  });

  it("loads SOUL.md from the workspace and renders it into instructions", async () => {
    await writeFile(path.join(workspaceDir, "SOUL.md"), "Soul voice goes here.");
    const result = await resolveCopilotWorkspaceBootstrapContext({
      attempt: makeAttempt({ workspaceDir }),
      effectiveWorkspaceDir: workspaceDir,
    });
    expect(result.bootstrapFiles.length).toBeGreaterThan(0);
    expect(result.instructions).toBeDefined();
    expect(result.instructions).toContain("Soul voice goes here.");
  });

  it("orders persona context and renders the SOUL hint through the workspace boundary", async () => {
    await writeFile(path.join(workspaceDir, "USER.md"), "USER body");
    await writeFile(path.join(workspaceDir, "SOUL.md"), "SOUL body");
    const result = await resolveCopilotWorkspaceBootstrapContext({
      attempt: makeAttempt({ workspaceDir }),
      effectiveWorkspaceDir: workspaceDir,
    });
    const instructions = result.instructions ?? "";
    expect(instructions).toContain("SOUL.md: persona/tone");
    expect(instructions.indexOf("SOUL body")).toBeLessThan(instructions.indexOf("USER body"));
    expect(instructions).toContain(`## ${path.join(workspaceDir, "SOUL.md")}`);
    expect(instructions).toContain(`## ${path.join(workspaceDir, "USER.md")}`);
  });

  it("filters AGENTS.md out of the rendered block (SDK loads it natively)", async () => {
    await writeFile(path.join(workspaceDir, "AGENTS.md"), "Follow AGENTS guidance.");
    await writeFile(path.join(workspaceDir, "SOUL.md"), "Soul voice goes here.");
    const result = await resolveCopilotWorkspaceBootstrapContext({
      attempt: makeAttempt({ workspaceDir }),
      effectiveWorkspaceDir: workspaceDir,
    });
    expect(result.instructions).toContain("Soul voice goes here.");
    expect(result.instructions).not.toContain("Follow AGENTS guidance.");
    expect(result.instructions).toContain("Copilot SDK loads AGENTS.md natively");
  });

  it("includes [MISSING] placeholders for files that don't exist (parity with PI/codex)", async () => {
    await writeFile(path.join(workspaceDir, "AGENTS.md"), "Follow AGENTS guidance.");
    const result = await resolveCopilotWorkspaceBootstrapContext({
      attempt: makeAttempt({ workspaceDir }),
      effectiveWorkspaceDir: workspaceDir,
    });
    // The shared loader synthesizes `[MISSING] Expected at: <path>`
    // entries for every known bootstrap file the workspace hasn't
    // provided yet. This is intentional — PI and codex inject the
    // same placeholders so the model can see what bootstrap files are
    // expected and prompt the user / create them. See
    // src/agents/pi-embedded-helpers/bootstrap.ts:293-296.
    // We surface these in the rendered block exactly like codex does.
    expect(result.instructions).toBeDefined();
    expect(result.instructions).toContain("[MISSING] Expected at:");
    expect(result.instructions).toContain("SOUL.md");
    // AGENTS.md content is still suppressed because the SDK auto-loads
    // it natively from workingDirectory.
    expect(result.instructions).not.toContain("Follow AGENTS guidance.");
  });
});

describe("resolveCopilotWorkspaceBootstrapContext sandbox remap (PR #86155 [P2] round-9)", () => {
  let workspaceDir: string;
  let sandboxDir: string;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(path.join(tmpdir(), "copilot-bootstrap-host-"));
    sandboxDir = await mkdtemp(path.join(tmpdir(), "copilot-bootstrap-sbx-"));
  });

  afterEach(async () => {
    await rm(workspaceDir, { force: true, recursive: true });
    await rm(sandboxDir, { force: true, recursive: true });
  });

  it("rewrites rendered context paths from host workspace to sandbox workspace when effective differs", async () => {
    // Readonly sandbox: bootstrap files live on the host workspace
    // (the canonical source of SOUL.md / .openclaw conventions), but
    // the SDK session's workingDirectory and bridged tools see the
    // sandbox copy. The rendered systemMessage must show the model
    // sandbox paths, not host paths, so it matches what the native
    // SDK loader and the wrapped tools report.
    await writeFile(path.join(workspaceDir, "SOUL.md"), "Soul voice from host.");
    const result = await resolveCopilotWorkspaceBootstrapContext({
      attempt: makeAttempt({ workspaceDir }),
      effectiveWorkspaceDir: sandboxDir,
    });
    expect(result.instructions).toBeDefined();
    expect(result.instructions).toContain("Soul voice from host.");
    // Positive: every rendered `## ` file header is now under the
    // sandbox root so the model sees a workspace it can actually
    // dereference through the bridged tools.
    expect(result.instructions).toContain(`## ${path.join(sandboxDir, "SOUL.md")}`);
    // Negative: no rendered file header may still point at the
    // host workspace root (would otherwise let the model dereference
    // a path its tools cannot reach in a readonly sandbox). We scope
    // this check to `## ` headers because PI deliberately leaves the
    // host path inside any `[MISSING] Expected at: <path>` body — it
    // refers to the canonical source location the user should create
    // the file at, not the runtime workspace.
    const headerLines = (result.instructions ?? "")
      .split("\n")
      .filter((line) => line.startsWith("## "));
    expect(headerLines.length).toBeGreaterThan(0);
    for (const line of headerLines) {
      expect(line).not.toContain(workspaceDir);
    }
    // Returned contextFiles array reflects the remap too, so any
    // future consumer that reads `contextFiles` directly stays in
    // lock-step with `instructions`.
    expect(result.contextFiles.map((f) => f.path)).toContain(path.join(sandboxDir, "SOUL.md"));
    expect(result.contextFiles.every((f) => !f.path.startsWith(workspaceDir))).toBe(true);
  });
});
