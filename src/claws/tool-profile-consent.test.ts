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
    const coding = resolveToolProfilePolicy("coding");
    if (!coding?.allow) {
      throw new Error("expected coding profile allowlist");
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
            profile: "coding",
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
      allow: [...coding.allow, "tts"],
      deny: ["exec"],
      fs: { workspaceOnly: true },
    });
    expect(plan.capabilityChanges).toContainEqual(
      expect.objectContaining({
        path: "agent",
        effect: expect.objectContaining({
          tools: expect.objectContaining({ profile: "coding", alsoAllow: ["tts"] }),
        }),
      }),
    );
  });

  it("preserves an explicit allowlist as a frozen profile intersection", async () => {
    const settings = materializeClawToolProfile({
      tools: {
        profile: "coding",
        allow: ["read", "write"],
      },
    });

    expect(settings.tools).toEqual({
      profile: "full",
      allow: ["read", "write", "apply_patch"],
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
});
