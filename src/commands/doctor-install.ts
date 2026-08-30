/** Doctor warnings for source checkout installs with missing pnpm runtime state. */
import fs from "node:fs";
import path from "node:path";
import { note } from "../../packages/terminal-core/src/note.js";

/** Emits install warnings when a source checkout looks npm-installed or lacks source-run deps. */
export function noteSourceInstallIssues(root: string | null) {
  if (!root) {
    return;
  }

  const srcEntry = path.join(root, "src", "entry.ts");
  const workspaceMarker = path.join(root, "pnpm-workspace.yaml");
  if (!fs.existsSync(workspaceMarker) || !fs.existsSync(srcEntry)) {
    return;
  }

  const warnings: string[] = [];
  const nodeModules = path.join(root, "node_modules");
  const pnpmStore = path.join(nodeModules, ".pnpm");
  const tsxBin = path.join(nodeModules, ".bin", "tsx");

  if (fs.existsSync(nodeModules) && !fs.existsSync(pnpmStore)) {
    warnings.push(
      "- node_modules was not installed by pnpm (missing node_modules/.pnpm). Run: pnpm install so bundled plugins can load package-local dependencies.",
    );
  }

  if (fs.existsSync(path.join(root, "package-lock.json"))) {
    warnings.push(
      "- package-lock.json present in a pnpm workspace. If you ran npm install, remove it and reinstall with pnpm.",
    );
  }

  if (fs.existsSync(srcEntry) && !fs.existsSync(tsxBin)) {
    warnings.push("- tsx binary is missing for source runs. Run: pnpm install.");
  }

  warnings.push(...detectSelfLinkWarnings(root));

  if (warnings.length > 0) {
    note(warnings.join("\n"), "Install");
  }
}

const SELF_LINK_RECOVERY =
  "Inspect the diff: git diff package.json pnpm-workspace.yaml. Manually revert only the self-referential link: lines, then reinstall: pnpm install. Never run pnpm link/npm link inside a deployment checkout.";

/** Detects self-referential `openclaw: link:` damage left by link commands run inside a source checkout. */
function detectSelfLinkWarnings(root: string): string[] {
  const warnings: string[] = [];

  const packageJsonPath = path.join(root, "package.json");
  if (fs.existsSync(packageJsonPath)) {
    try {
      // SAFETY: JSON.parse of a package.json file yields an object with optional dependency maps.
      const manifest = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const selfLink = [manifest.dependencies, manifest.devDependencies].some(
        (deps) => typeof deps?.openclaw === "string" && deps.openclaw.startsWith("link:"),
      );
      if (selfLink) {
        warnings.push(
          `- package.json has a self-referential "openclaw": "link:" dependency, which breaks frozen pnpm installs (ERR_PNPM_LOCKFILE_CONFIG_MISMATCH). ${SELF_LINK_RECOVERY}`,
        );
      }
    } catch {
      // Unparseable package.json is reported by other checks; skip link detection.
    }
  }

  const workspacePath = path.join(root, "pnpm-workspace.yaml");
  if (fs.existsSync(workspacePath)) {
    const workspaceYaml = fs.readFileSync(workspacePath, "utf8");
    // Only flag self-referential links inside the overrides: section, not any
    // indented openclaw: mapping elsewhere in the workspace file.
    const overridesMatch = workspaceYaml.match(/^overrides:\s*\n((?:^[ \t]+.*\n?)*)/m);
    const overridesBody = overridesMatch?.[1];
    if (overridesBody && /^[ \t]+openclaw:\s*['"]?link:/m.test(overridesBody)) {
      warnings.push(
        `- pnpm-workspace.yaml contains a self-referential "openclaw: link:" entry, which breaks frozen pnpm installs (ERR_PNPM_LOCKFILE_CONFIG_MISMATCH). ${SELF_LINK_RECOVERY}`,
      );
    }
  }

  return warnings;
}
