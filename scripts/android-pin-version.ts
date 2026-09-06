// Android pinning is retired; the shared mobile cutter owns release metadata.
import { isDirectRunUrl } from "./lib/direct-run.mjs";

const RETIRED_MESSAGE =
  "Android version pinning is retired. Run the shared mobile cutter in scripts/mobile-release-version.ts.";

function printUsage(): void {
  process.stdout.write(`${RETIRED_MESSAGE}\n`);
}

export async function main(argv: string[]): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    printUsage();
    return 0;
  }
  process.stderr.write(`${RETIRED_MESSAGE}\n`);
  return 1;
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  const exitCode = await main(process.argv.slice(2));
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
