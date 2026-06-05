// Ios Sync Versioning script supports OpenClaw repository automation.
import path from "node:path";
import { syncIosVersioning } from "./lib/ios-version.ts";

type Mode = "check" | "write";

export function parseArgs(argv: string[]): { mode: Mode; rootDir: string } {
  let mode: Mode = "write";
  let rootDir = path.resolve(".");

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--check": {
        mode = "check";
        break;
      }
      case "--write": {
        mode = "write";
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
          "Usage: node --import tsx scripts/ios-sync-versioning.ts [--write|--check] [--root dir]",
        );
        process.exit(0);
      }
      default: {
        throw new Error(`Unknown argument: ${arg}`);
      }
    }
  }

  return { mode, rootDir };
}

const options = parseArgs(process.argv.slice(2));
const result = syncIosVersioning({ mode: options.mode, rootDir: options.rootDir });

if (options.mode === "check") {
  process.stdout.write("iOS versioning artifacts are up to date.\n");
} else if (result.updatedPaths.length === 0) {
  process.stdout.write("iOS versioning artifacts already up to date.\n");
} else {
  process.stdout.write(
    `Updated iOS versioning artifacts:\n- ${result.updatedPaths.map((filePath) => path.relative(process.cwd(), filePath)).join("\n- ")}\n`,
  );
}
