const RETIRED_MESSAGE =
  "Standalone iOS release cutting is retired. Use scripts/mobile-release-version.ts " +
  "--prepare, capture pnpm ios:release:plan -- --json, then use --finalize.";

if (process.argv.includes("-h") || process.argv.includes("--help")) {
  process.stdout.write(`${RETIRED_MESSAGE}\n`);
  process.exit(0);
}

console.error(RETIRED_MESSAGE);
process.exit(1);
