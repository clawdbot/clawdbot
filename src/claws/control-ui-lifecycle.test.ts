import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  bindClawLifecycleTrust,
  canonicalizeClawSourcePlan,
  plansMatchAcrossSourceRoots,
  projectClawAddPlan,
  sealClawLifecyclePlan,
} from "./control-ui-lifecycle.js";
import type { ClawAddPlan } from "./types.js";

const projected = {
  operation: "add" as const,
  target: { agentId: "analyst", name: "financial-analyst", targetVersion: "1.0.0" },
  actions: [{ kind: "workspaceFile", id: "SOUL.md", action: "add", blocked: false }],
  capabilities: [],
  blockers: [],
  riskAcknowledgementRequired: false,
};

describe("sealClawLifecyclePlan", () => {
  it("binds the secret-safe preview token to the full canonical plan", () => {
    const first = sealClawLifecyclePlan(projected, "sha256:canonical-content-a");
    const second = sealClawLifecyclePlan(projected, "sha256:canonical-content-b");

    expect(first.planIntegrity).not.toBe(second.planIntegrity);
    expect(JSON.stringify(first)).not.toContain("canonical-content-a");
  });

  it("normalizes only paths contained by the verified package root", () => {
    const previewRoot = path.resolve("tmp", "extracted");
    const persistedRoot = path.resolve("state", "claws", "sources", "digest");
    const relativeSource = path.join("workspace", "SOUL.md");
    const destination = path.resolve("home", "operator", ".openclaw", "workspace", "SOUL.md");
    const first = canonicalizeClawSourcePlan(
      {
        source: path.join(previewRoot, relativeSource),
        destination,
      },
      previewRoot,
    );
    const second = canonicalizeClawSourcePlan(
      {
        source: path.join(persistedRoot, relativeSource),
        destination,
      },
      persistedRoot,
    );

    expect(first).toEqual(second);
    expect(first).toEqual({
      source: "$CLAW_SOURCE/workspace/SOUL.md",
      destination,
    });
  });

  it("accepts a cache-root move but rejects changed package content", () => {
    const previewRoot = path.resolve("tmp", "extracted");
    const persistedRoot = path.resolve("state", "claws", "sources", "digest");
    const preview = {
      planIntegrity: "sha256:temporary-path-plan",
      action: { source: path.join(previewRoot, "workspace", "SOUL.md"), digest: "same" },
    };
    const persisted = {
      planIntegrity: "sha256:persistent-path-plan",
      action: { source: path.join(persistedRoot, "workspace", "SOUL.md"), digest: "same" },
    };

    expect(plansMatchAcrossSourceRoots({ preview, previewRoot, persisted, persistedRoot })).toBe(
      true,
    );
    expect(
      plansMatchAcrossSourceRoots({
        preview,
        previewRoot,
        persisted: { ...persisted, action: { ...persisted.action, digest: "changed" } },
        persistedRoot,
      }),
    ).toBe(false);
  });

  it("invalidates consent when the displayed trust disclosure changes", () => {
    const base = sealClawLifecyclePlan(projected, "sha256:canonical-content");
    const reviewed = bindClawLifecycleTrust(base, {
      trustWarning: "Review this release.",
      riskAcknowledgementRequired: true,
    });
    const changed = bindClawLifecycleTrust(base, {
      trustWarning: "This release now has a different warning.",
      riskAcknowledgementRequired: true,
    });

    expect(reviewed.planIntegrity).not.toBe(changed.planIntegrity);
    expect(reviewed.planIntegrity).not.toBe(base.planIntegrity);
  });

  it("projects readiness owners without environment or auth values", () => {
    const result = projectClawAddPlan({
      schemaVersion: "openclaw.clawAddPlan.v1",
      planIntegrity: "sha256:canonical",
      claw: { name: "analyst", version: "1.0.0", integrity: "sha256:package" },
      agent: { finalId: "analyst" },
      actions: [],
      capabilityChanges: [],
      blockers: [],
      readiness: {
        ready: false,
        requirements: [
          { kind: "environment", mcpServer: "markets", name: "PRIVATE_MARKETS_TOKEN" },
          { kind: "oauth", mcpServer: "mail" },
          {
            kind: "plugin-setup",
            plugin: "diffs",
            provider: "github",
            envVars: ["PRIVATE_GITHUB_TOKEN"],
            authMethods: ["oauth"],
          },
        ],
      },
    } as unknown as ClawAddPlan);

    expect(result.readiness?.requirements).toEqual([
      { kind: "environment", owner: "markets" },
      { kind: "oauth", owner: "mail" },
      { kind: "plugin-setup", owner: "diffs/github" },
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("PRIVATE_MARKETS_TOKEN");
    expect(serialized).not.toContain("PRIVATE_GITHUB_TOKEN");
  });
});
