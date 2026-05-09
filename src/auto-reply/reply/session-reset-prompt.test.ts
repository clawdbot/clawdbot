import fs from "node:fs/promises";
import path from "node:path";
import { describe, it, expect } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { makeTempWorkspace } from "../../test-helpers/workspace.js";
import {
  buildBareSessionResetPrompt,
  resolveBareSessionResetPromptState,
} from "./session-reset-prompt.js";

describe("buildBareSessionResetPrompt", () => {
  it("includes the explicit Session Startup instruction for bare /new and /reset", () => {
    const prompt = buildBareSessionResetPrompt();
    expect(prompt).toContain("Execute your Session Startup sequence now");
    expect(prompt).toContain("read the required files before responding to the user");
    expect(prompt).toContain("If BOOTSTRAP.md exists in the provided Project Context");
    expect(prompt).toContain("read it and follow its instructions first");
    expect(prompt).not.toContain(
      "If runtime-provided startup context is included for this first turn",
    );
  });

  it("uses bootstrap-specific wording when bootstrap is still pending", () => {
    const prompt = buildBareSessionResetPrompt(undefined, undefined, "full");

    expect(prompt).toContain("while bootstrap is still pending for this workspace");
    expect(prompt).toContain("Please read BOOTSTRAP.md from the workspace now");
    expect(prompt).toContain("If this run can complete the BOOTSTRAP.md workflow, do so.");
    expect(prompt).toContain("explain the blocker briefly");
    expect(prompt).toContain("offer the simplest next step");
    expect(prompt).toContain("Do not pretend bootstrap is complete when it is not.");
    expect(prompt).toContain("Your first user-visible reply must follow BOOTSTRAP.md");
    expect(prompt).not.toContain("Then greet the user in your configured persona");
  });

  it("uses limited bootstrap wording for constrained reset runs", () => {
    const prompt = buildBareSessionResetPrompt(undefined, undefined, "limited");

    expect(prompt).toContain("cannot safely complete the full BOOTSTRAP.md workflow here");
    expect(prompt).toContain("Do not claim bootstrap is complete");
    expect(prompt).toContain("do not use a generic first greeting");
    expect(prompt).toContain("switching to a primary interactive run with normal workspace access");
    expect(prompt).not.toContain("Please read BOOTSTRAP.md from the workspace now");
  });

  it("appends current time line so agents know the date", () => {
    const cfg = {
      agents: { defaults: { userTimezone: "America/New_York", timeFormat: "12" } },
    } as OpenClawConfig;
    // 2026-03-03 14:00 UTC = 2026-03-03 09:00 EST
    const nowMs = Date.UTC(2026, 2, 3, 14, 0, 0);
    const prompt = buildBareSessionResetPrompt(cfg, nowMs);
    expect(prompt).toContain("Current time: Tuesday, March 3rd, 2026 - 9:00 AM (America/New_York)");
    expect(prompt).toContain("Reference UTC: 2026-03-03 14:00 UTC");
  });

  it("does not append a duplicate current time line", () => {
    const nowMs = Date.UTC(2026, 2, 3, 14, 0, 0);
    const prompt = buildBareSessionResetPrompt(undefined, nowMs);
    expect((prompt.match(/Current time:/g) ?? []).length).toBe(1);
  });

  it("falls back to UTC when no timezone configured", () => {
    const nowMs = Date.UTC(2026, 2, 3, 14, 0, 0);
    const prompt = buildBareSessionResetPrompt(undefined, nowMs);
    expect(prompt).toContain("Current time:");
  });

  it("resolves shared bare reset prompt state from workspace bootstrap truth", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-reset-bootstrap-");
    await fs.writeFile(path.join(workspaceDir, "BOOTSTRAP.md"), "ritual", "utf8");

    const pending = await resolveBareSessionResetPromptState({ workspaceDir });
    expect(pending.bootstrapMode).toBe("full");
    expect(pending.shouldPrependStartupContext).toBe(false);
    expect(pending.prompt).toContain("while bootstrap is still pending for this workspace");

    await fs.unlink(path.join(workspaceDir, "BOOTSTRAP.md"));

    const complete = await resolveBareSessionResetPromptState({ workspaceDir });
    expect(complete.bootstrapMode).toBe("none");
    expect(complete.shouldPrependStartupContext).toBe(true);
    expect(complete.prompt).toContain("Execute your Session Startup sequence now");
  });

  it("does not resolve bootstrap file access when bootstrap is complete", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-reset-bootstrap-complete-");
    let resolvedAccess = false;

    const complete = await resolveBareSessionResetPromptState({
      workspaceDir,
      hasBootstrapFileAccess: () => {
        resolvedAccess = true;
        return false;
      },
    });

    expect(complete.bootstrapMode).toBe("none");
    expect(complete.shouldPrependStartupContext).toBe(true);
    expect(resolvedAccess).toBe(false);
  });

  it("suppresses bootstrap mode for non-primary bare reset sessions", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-reset-non-primary-");
    await fs.writeFile(path.join(workspaceDir, "BOOTSTRAP.md"), "ritual", "utf8");

    const pending = await resolveBareSessionResetPromptState({
      workspaceDir,
      isPrimaryRun: false,
    });

    expect(pending.bootstrapMode).toBe("none");
    expect(pending.shouldPrependStartupContext).toBe(true);
    expect(pending.prompt).toContain("Execute your Session Startup sequence now");
    expect(pending.prompt).not.toContain("while bootstrap is still pending for this workspace");
  });

  it("uses limited bootstrap mode when bare reset has no bootstrap file access", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-reset-no-file-access-");
    await fs.writeFile(path.join(workspaceDir, "BOOTSTRAP.md"), "ritual", "utf8");

    const pending = await resolveBareSessionResetPromptState({
      workspaceDir,
      hasBootstrapFileAccess: false,
    });

    expect(pending.bootstrapMode).toBe("limited");
    expect(pending.shouldPrependStartupContext).toBe(false);
    expect(pending.prompt).toContain("cannot safely complete the full BOOTSTRAP.md workflow here");
    expect(pending.prompt).toContain("while bootstrap is still pending for this workspace");
    expect(pending.prompt).not.toContain("Execute your Session Startup sequence now");
  });
});
