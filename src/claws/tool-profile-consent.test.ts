import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveToolProfilePolicy } from "../agents/tool-policy-shared.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { parseClawManifest } from "./schema.js";
import { materializeClawToolProfile } from "./tool-profile-consent.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("Claw tool profile consent", () => {
  it("materializes a built-in profile into the consented agent config", async () => {
    const minimal = resolveToolProfilePolicy("minimal");
    if (!minimal?.allow) {
      throw new Error("expected minimal profile allowlist");
    }
    const packageRoot = tempDirs.make("openclaw-claw-tool-profile-");
    await mkdir(packageRoot, { recursive: true });
    const parsed = parseClawManifest({
      schemaVersion: 1,
      agent: { id: "profile-worker" },
    });
    if (!parsed.ok) {
      throw new Error(JSON.stringify(parsed.diagnostics));
    }

    const plan = await buildClawAddPlan({
      manifest: parsed.manifest,
      openClawProfile: {
        schemaVersion: 1,
        agent: {
          tools: {
            profile: "minimal",
            alsoAllow: ["tts"],
            deny: ["exec"],
            fs: { workspaceOnly: true },
          },
        },
      },
      source: {
        kind: "package",
        name: "@acme/profile-worker",
        version: "1.0.0",
        packageRoot,
        manifestPath: join(packageRoot, "openclaw.claw.json"),
        integrityKind: "development-snapshot",
        integrity: "sha256:test",
        byteLength: 0,
      },
      context: { workspace: join(packageRoot, "workspace") },
    });

    expect(plan.agent.config.tools).toEqual({
      profile: "full",
      allow: [...minimal.allow, "tts"],
      deny: ["exec"],
      fs: { workspaceOnly: true },
    });
    expect(plan.capabilityChanges).toContainEqual(
      expect.objectContaining({
        path: "agent",
        effect: expect.objectContaining({
          tools: expect.objectContaining({ profile: "minimal", alsoAllow: ["tts"] }),
        }),
      }),
    );
  });

  it("preserves an explicit allowlist as a frozen profile intersection", async () => {
    const settings = materializeClawToolProfile({
      tools: {
        profile: "coding",
        allow: ["read", "write", "github__list_issues"],
      },
    });

    expect(settings.tools).toEqual({
      profile: "full",
      allow: ["read", "write", "apply_patch", "github__list_issues"],
    });
  });

  it("uses a bounded full profile to override inherited global profiles", () => {
    expect(
      materializeClawToolProfile({
        tools: {
          profile: "full",
          allow: ["read", "write"],
        },
      }).tools,
    ).toEqual({
      profile: "full",
      allow: ["read", "write"],
    });
  });

  it("freezes a standalone allowlist against inherited host profiles", () => {
    expect(
      materializeClawToolProfile({
        tools: {
          allow: ["read", "write", "cron"],
          deny: ["exec"],
        },
      }).tools,
    ).toEqual({
      profile: "full",
      allow: ["read", "write", "automations"],
      deny: ["exec"],
    });
  });

  it("freezes the bounded portion of a legacy dynamic profile for update", () => {
    const settings = materializeClawToolProfile(
      {
        tools: {
          profile: "coding",
          deny: ["exec"],
        },
      },
      { allowLegacyDynamicProfile: true },
    );

    expect(settings.tools).toMatchObject({
      profile: "full",
      allow: expect.arrayContaining(["read", "write", "apply_patch"]),
      deny: ["exec"],
    });
    expect(settings.tools?.allow).not.toContain("bundle-mcp");
  });

  it("fails closed for an empty explicit profile intersection", () => {
    expect(() =>
      materializeClawToolProfile({
        tools: {
          profile: "coding",
          allow: ["tts"],
        },
      }),
    ).toThrow("does not overlap");
  });

  it("rejects an unresolved Bundle MCP selector in a frozen profile", () => {
    expect(() =>
      materializeClawToolProfile({
        tools: {
          profile: "coding",
        },
      }),
    ).toThrow("bundle-mcp");
  });
});
