import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  crabboxWarmImageRecoveryHint,
  isCrabboxWarmImageCapturePaused,
  listCrabboxLegacyWarmLeases,
  listCrabboxWarmImages,
  recoverCrabboxWarmImageCapture,
} from "./crabbox-worker-warm-image-store.js";

type CliProgram = Parameters<Parameters<OpenClawPluginApi["registerCli"]>[0]>[0]["program"];

export function registerCrabboxWarmImageCommands(program: CliProgram): void {
  program
    .command("crabbox")
    .description("Manage Crabbox warm images")
    .command("warm-images")
    .description("Inspect local warm-image ownership or acknowledge manual provider cleanup")
    .option("--json", "Print local warm-image records as JSON")
    .option(
      "--recover <selector>",
      "Clear the exact capture or legacy allocation shown by inspection after manual cleanup",
    )
    .option(
      "--acknowledge-provider-cleanup",
      "Confirm owning processes and recovered workers are stopped and provider artifacts are reconciled",
    )
    .action(
      (options: { json?: boolean; recover?: string; acknowledgeProviderCleanup?: boolean }) => {
        if (options.acknowledgeProviderCleanup && !options.recover) {
          throw new Error(
            "--acknowledge-provider-cleanup requires --recover <selector> from warm-images inspection.",
          );
        }
        if (options.recover) {
          recoverCrabboxWarmImageCapture(
            options.recover,
            options.acknowledgeProviderCleanup === true,
          );
        }
        const images = listCrabboxWarmImages();
        const legacyLeases = listCrabboxLegacyWarmLeases();
        const nextSteps =
          "Restart the Gateway after manual reconciliation; the next eligible worker can capture again.";
        if (options.json) {
          process.stdout.write(
            `${JSON.stringify({ images, legacyLeases, ...(options.recover ? { recoveredCapture: options.recover, nextSteps } : {}) }, null, 2)}\n`,
          );
          return;
        }
        const lines = options.recover
          ? [
              "Selected recovery record cleared; retained images and other allocation choices are preserved. No provider commands were run.",
              nextSteps,
            ]
          : [];
        if (images.length === 0 && legacyLeases.length === 0) {
          lines.push("No Crabbox warm images are recorded locally.");
        }
        for (const lease of legacyLeases) {
          lines.push(
            `Legacy worker allocation ${lease.leaseId}: original image choice is unknown.`,
          );
          lines.push(`  ${crabboxWarmImageRecoveryHint(lease.selector)}`);
        }
        for (const image of images) {
          lines.push(
            `${image.profileKey}: ${image.checkpointId ?? "no checkpoint"} (${image.state})`,
          );
          if (image.capture) {
            const paused = isCrabboxWarmImageCapturePaused(image.capture);
            lines.push(`  Capture ${paused ? "paused" : "in progress"}: ${image.capture.selector}`);
            if (paused) {
              lines.push(`  ${crabboxWarmImageRecoveryHint(image.capture.selector)}`);
            }
          }
          if (image.retirement) {
            lines.push(
              `  Checkpoint deletion pending: ${image.retirement.checkpointId}; retried during the next warm-image capture or worker teardown.`,
            );
          }
        }
        process.stdout.write(`${lines.join("\n")}\n`);
      },
    );
}
