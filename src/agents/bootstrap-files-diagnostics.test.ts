/** Tests doctor-side bootstrap resolution and its bundled hook projection gate. */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearInternalHooks } from "../hooks/internal-hooks.js";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import { resolveBootstrapContextForDiagnostics } from "./bootstrap-files-diagnostics.js";

describe("resolveBootstrapContextForDiagnostics", () => {
  beforeEach(() => clearInternalHooks());
  afterEach(() => clearInternalHooks());

  function createExtraFilesConfig(hooksEnabled?: boolean): OpenClawConfig {
    return {
      hooks: {
        internal: {
          enabled: hooksEnabled,
          entries: {
            "bootstrap-extra-files": { enabled: true, paths: ["packages/*/AGENTS.md"] },
          },
        },
      },
    };
  }

  async function makeWorkspaceWithExtraAgentsFile(): Promise<{
    workspaceDir: string;
    extraPath: string;
  }> {
    const workspaceDir = await fs.realpath(await makeTempWorkspace("openclaw-bootstrap-diag-"));
    const extraPath = path.join(workspaceDir, "packages", "core", "AGENTS.md");
    await fs.mkdir(path.dirname(extraPath), { recursive: true });
    await fs.writeFile(extraPath, "extra agents", "utf8");
    return { workspaceDir, extraPath };
  }

  it("projects bootstrap-extra-files additions without a registered handler", async () => {
    const { workspaceDir, extraPath } = await makeWorkspaceWithExtraAgentsFile();

    const result = await resolveBootstrapContextForDiagnostics({
      workspaceDir,
      config: createExtraFilesConfig(),
    });

    expect(result.bootstrapFiles.map((file) => file.path)).toContain(extraPath);
    expect(result.contextFiles.find((file) => file.path === extraPath)?.content).toBe(
      "extra agents",
    );
  });

  it("projects nothing while the hook system is disabled", async () => {
    const { workspaceDir, extraPath } = await makeWorkspaceWithExtraAgentsFile();

    const result = await resolveBootstrapContextForDiagnostics({
      workspaceDir,
      config: createExtraFilesConfig(false),
    });

    expect(result.bootstrapFiles.map((file) => file.path)).not.toContain(extraPath);
  });

  // A managed hook with the bundled name wins selection, so the runtime never runs
  // the bundled handler and doctor must not describe its additions. A handlerless
  // replacement still shadows it: the Gateway's atomic reload keeps that source,
  // fails, and leaves whatever handler it already had registered.
  it.each([
    ["a loadable handler", true],
    ["no readable handler", false],
  ])(
    "projects nothing when a managed hook with %s replaces the bundled one",
    async (_label, withHandler) => {
      const { workspaceDir, extraPath } = await makeWorkspaceWithExtraAgentsFile();
      const managedHooksDir = await makeTempWorkspace("openclaw-managed-hooks-");
      const replacementDir = path.join(managedHooksDir, "bootstrap-extra-files");
      await fs.mkdir(replacementDir, { recursive: true });
      await fs.writeFile(
        path.join(replacementDir, "HOOK.md"),
        [
          "---",
          "name: bootstrap-extra-files",
          "description: managed replacement",
          'metadata: { "openclaw": { "events": ["agent:bootstrap"] } }',
          "---",
          "",
        ].join("\n"),
        "utf8",
      );
      if (withHandler) {
        await fs.writeFile(
          path.join(replacementDir, "handler.js"),
          "export default async () => {};\n",
          "utf8",
        );
      }
      const config = createExtraFilesConfig();
      config.hooks!.internal!.load = { extraDirs: [managedHooksDir] };

      const result = await resolveBootstrapContextForDiagnostics({ workspaceDir, config });

      expect(result.bootstrapFiles.map((file) => file.path)).not.toContain(extraPath);
    },
  );
});
