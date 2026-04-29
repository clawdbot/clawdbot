import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";

const __dirname = dirname(fileURLToPath(import.meta.url));

const ALLOWED_TLON_COMMANDS = new Set([
  "activity",
  "channels",
  "contacts",
  "groups",
  "messages",
  "dms",
  "posts",
  "notebook",
  "settings",
  "help",
  "version",
]);

let cachedTlonBinary: string | undefined;

function findTlonBinary(): string {
  if (cachedTlonBinary) {
    return cachedTlonBinary;
  }
  const skillBin = join(__dirname, "node_modules", ".bin", "tlon");
  if (existsSync(skillBin)) {
    cachedTlonBinary = skillBin;
    return skillBin;
  }

  const platformPkg = `@tloncorp/tlon-skill-${process.platform}-${process.arch}`;
  const platformBin = join(__dirname, "node_modules", platformPkg, "tlon");
  if (existsSync(platformBin)) {
    cachedTlonBinary = platformBin;
    return platformBin;
  }

  cachedTlonBinary = "tlon";
  return cachedTlonBinary;
}

function shellSplit(str: string): string[] {
  const args: string[] = [];
  let cur = "";
  let inDouble = false;
  let inSingle = false;
  let escape = false;

  for (const ch of str) {
    if (escape) {
      cur += ch;
      escape = false;
      continue;
    }
    if (ch === "\\" && !inSingle) {
      escape = true;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (/\s/.test(ch) && !inDouble && !inSingle) {
      if (cur) {
        args.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur) {
    args.push(cur);
  }
  return args;
}

function runTlonCommand(binary: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env: process.env });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", (err) => {
      reject(new Error(`Failed to run tlon: ${err.message}`));
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `tlon exited with code ${code}`));
        return;
      }
      resolve(stdout);
    });
  });
}

export default defineBundledChannelEntry({
  id: "tlon",
  name: "Tlon",
  description: "Tlon/Urbit channel plugin",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "tlonPlugin",
  },
  runtime: {
    specifier: "./api.js",
    exportName: "setTlonRuntime",
  },
  registerFull(api) {
    api.registerTool({
      name: "tlon",
      label: "Tlon CLI",
      description:
        "Tlon/Urbit API operations: activity, channels, contacts, groups, messages, dms, posts, notebook, settings. " +
        "Examples: 'activity mentions --limit 10', 'channels groups', 'contacts self', 'groups list'",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description:
              "The tlon command and arguments. " +
              "Examples: 'activity mentions --limit 10', 'contacts get ~sampel-palnet', 'groups list'",
          },
        },
        required: ["command"],
      },
      async execute(_id: string, params: { command: string }) {
        try {
          const args = shellSplit(params.command);
          const subcommand = args[0];
          if (!ALLOWED_TLON_COMMANDS.has(subcommand)) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Error: Unknown tlon subcommand '${subcommand}'. Allowed: ${[...ALLOWED_TLON_COMMANDS].join(", ")}`,
                },
              ],
              details: { error: true },
            };
          }

          const output = await runTlonCommand(findTlonBinary(), args);
          return {
            content: [{ type: "text" as const, text: output }],
            details: undefined,
          };
        } catch (error: unknown) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: ${formatErrorMessage(error)}`,
              },
            ],
            details: { error: true },
          };
        }
      },
    });
  },
});
