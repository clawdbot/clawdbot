import { runGatewayUpdate } from "../infra/update-runner.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { runCommandWithTimeout } from "../process/exec.js";
import type { RuntimeEnv } from "../runtime.js";
import { note } from "../terminal/note.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { DoctorOptions } from "./doctor-prompter.js";

async function detectMoltbotGitCheckout(root: string): Promise<"git" | "not-git" | "unknown"> {
  const res = await runCommandWithTimeout(["git", "-C", root, "rev-parse", "--show-toplevel"], {
    timeoutMs: 5000,
  }).catch(() => null);
  if (!res) return "unknown";
  if (res.code !== 0) {
    // Avoid noisy "Update via package manager" notes when git is missing/broken,
    // but do show it when this is clearly not a git checkout.
    if (res.stderr.toLowerCase().includes("not a git repository")) {
      return "not-git";
    }
    return "unknown";
  }
  return res.stdout.trim() === root ? "git" : "not-git";
}

export async function maybeOfferUpdateBeforeDoctor(params: {
  runtime: RuntimeEnv;
  options: DoctorOptions;
  root: string | null;
  confirm: (p: { message: string; initialValue: boolean }) => Promise<boolean>;
  outro: (message: string) => void;
}) {
  const updateInProgress = isTruthyEnvValue(process.env.CLAWDBOT_UPDATE_IN_PROGRESS);
  const canOfferUpdate =
    !updateInProgress &&
    params.options.nonInteractive !== true &&
    params.options.yes !== true &&
    params.options.repair !== true &&
    Boolean(process.stdin.isTTY);
  if (!canOfferUpdate || !params.root) return { updated: false };

  const git = await detectMoltbotGitCheckout(params.root);
  if (git === "git") {
    const shouldUpdate = await params.confirm({
      message: "Update Moltbot from git before running doctor?",
      initialValue: true,
    });
    if (!shouldUpdate) return { updated: false };
    note("Running update (fetch/rebase/build/ui:build/doctor)…", "Update");
    const result = await runGatewayUpdate({
      cwd: params.root,
      argv1: process.argv[1],
    });
    note(
      [
        `Status: ${result.status}`,
        `Mode: ${result.mode}`,
        result.root ? `Root: ${result.root}` : null,
        result.reason ? `Reason: ${result.reason}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
      "Update result",
    );
    if (result.status === "ok") {
      params.outro("Update completed (doctor already ran as part of the update).");
      return { updated: true, handled: true };
    }
    return { updated: true, handled: false };
  }

  if (git === "not-git") {
    note(
      [
        "This install is not a git checkout.",
        `Run \`${formatCliCommand("moltbot update")}\` to update via your package manager (npm/pnpm), then rerun doctor.`,
      ].join("\n"),
      "Update",
    );
  }

  return { updated: false };
}
