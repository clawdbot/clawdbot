import path from "node:path";
import { resolveIosVersion } from "./lib/ios-version.ts";

type CliOptions = {
  field: string | null;
  format: "json" | "shell";
  rootDir: string;
};

function parseArgs(argv: string[]): CliOptions {
  let field: string | null = null;
  let format: "json" | "shell" = "json";
  let rootDir = path.resolve(".");

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--field": {
        field = argv[index + 1] ?? null;
        index += 1;
        break;
      }
      case "--json": {
        format = "json";
        break;
      }
      case "--shell": {
        format = "shell";
        break;
      }
      case "--root": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("Missing value for --root.");
        }
        rootDir = path.resolve(value);
        index += 1;
        break;
      }
      case "-h":
      case "--help": {
        console.log(
          `Usage: node --import tsx scripts/ios-version.ts [--json|--shell] [--field name] [--root dir]\n`,
        );
        process.exit(0);
      }
      default: {
        throw new Error(`Unknown argument: ${arg}`);
      }
    }
  }

  return { field, format, rootDir };
}

const options = parseArgs(process.argv.slice(2));
const version = resolveIosVersion(options.rootDir);

if (options.field) {
  const value = version[options.field as keyof typeof version];
  if (value === undefined) {
    throw new Error(`Unknown iOS version field '${options.field}'.`);
  }
  process.stdout.write(`${value}\n`);
  process.exit(0);
}

if (options.format === "shell") {
  process.stdout.write(
    [
      `OPENCLAW_IOS_VERSION=${version.canonicalVersion}`,
      `OPENCLAW_MARKETING_VERSION=${version.marketingVersion}`,
      `OPENCLAW_BUILD_VERSION=${version.buildVersion}`,
    ].join("\n") + "\n",
  );
} else {
  process.stdout.write(`${JSON.stringify(version, null, 2)}\n`);
}
