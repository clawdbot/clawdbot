/** Doctor warnings for source checkout installs with missing pnpm runtime state. */
import fs from "node:fs";
import path from "node:path";
import { note } from "../../packages/terminal-core/src/note.js";
import { reconcileWindowsGitLauncher } from "../infra/windows-git-launcher.js";

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

  if (warnings.length > 0) {
    note(warnings.join("\n"), "Install");
  }
}

/** Migrates the installer-owned Windows Git launcher through Doctor/update repair. */
export async function repairWindowsGitLauncher(root: string | null, shouldRepair: boolean) {
  if (!root) {
    return;
  }
  const result = await reconcileWindowsGitLauncher({ root, repair: shouldRepair });
  if (result.status === "needs-repair") {
    note(
      `- ${result.launcherPath} does not use the current validated Node runtime. Run: openclaw doctor --fix`,
      "Install",
    );
  } else if (result.status === "needs-reinstall") {
    note(
      `- ${result.launcherPath} cannot be safely migrated from the current Node runtime. Re-run the OpenClaw installer.`,
      "Install",
    );
  } else if (result.status === "updated") {
    note(`- Updated ${result.launcherPath} to use the validated Node runtime.`, "Install");
  }
}
