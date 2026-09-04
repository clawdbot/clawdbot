import type { Command } from "commander";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";

const loadConfidenceBundle = createLazyRuntimeModule(() => import("./confidence-bundle.js"));

export function registerQaConfidenceBundleCli(qa: Command) {
  qa.command("confidence-export")
    .description("Capture a confidence profile and all lane inputs in a portable evidence bundle")
    .requiredOption("--manifest <path>", "Portable relative manifest path under the artifact root")
    .option("--artifact-root <path>", "Root containing the manifest and lane inputs", ".")
    .requiredOption("--output <path>", "New bundle file to create (never overwrites)")
    .option("--strict-zero-unknowns", "Capture the zero-unknown classification gate")
    .option("--strict-global-pass", "Capture the all-required-lanes-pass gate")
    .action(
      async (opts: {
        manifest: string;
        artifactRoot: string;
        output: string;
        strictZeroUnknowns?: boolean;
        strictGlobalPass?: boolean;
      }) => {
        const runtime = await loadConfidenceBundle();
        const result = await runtime.exportQaConfidenceBundle(opts);
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      },
    );

  qa.command("confidence-replay")
    .description(
      "Verify captured input bytes and replay confidence classification without execution",
    )
    .requiredOption("--bundle <path>", "Portable confidence evidence bundle")
    .requiredOption(
      "--expected-sha256 <digest>",
      "Bundle SHA-256 received through a trusted channel",
    )
    .action(async (opts: { bundle: string; expectedSha256: string }) => {
      const runtime = await loadConfidenceBundle();
      const result = await runtime.replayQaConfidenceBundle({
        bundlePath: opts.bundle,
        expectedSha256: opts.expectedSha256,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (!result.report.pass) {
        process.exitCode = 1;
      }
    });
}
