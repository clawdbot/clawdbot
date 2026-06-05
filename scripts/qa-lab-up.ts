// Qa Lab Up script supports OpenClaw repository automation.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const options = {
  help: { type: "boolean", short: "h" },
  "output-dir": { type: "string" },
  "gateway-port": { type: "string" },
  "qa-lab-port": { type: "string" },
  "provider-base-url": { type: "string" },
  image: { type: "string" },
  "use-prebuilt-image": { type: "boolean" },
  "bind-ui-dist": { type: "boolean" },
  "skip-ui-build": { type: "boolean" },
} as const;

function usage(): string {
  return `Usage: pnpm qa:lab:up [options]

Options:
  --output-dir <path>
  --gateway-port <port>
  --qa-lab-port <port>
  --provider-base-url <url>
  --image <name>
  --use-prebuilt-image
  --bind-ui-dist
  --skip-ui-build
  -h, --help
`;
}

function parseQaLabUpArgs(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    options,
    allowPositionals: false,
  }).values;
}

export const qaLabUpTesting = {
  parseQaLabUpArgs,
  runQaLabUp,
  usage,
};

type QaLabRuntime = typeof import("../extensions/qa-lab/src/cli.runtime.ts");

type QaLabUpDeps = {
  loadRuntime?: () => Promise<Pick<QaLabRuntime, "runQaDockerUpCommand">>;
  writeStdout?: (text: string) => void;
};

async function loadQaLabRuntime(): Promise<Pick<QaLabRuntime, "runQaDockerUpCommand">> {
  return await import("../extensions/qa-lab/src/cli.runtime.ts");
}

async function runQaLabUp(argv: readonly string[], deps: QaLabUpDeps = {}): Promise<number> {
  const values = parseQaLabUpArgs(argv);

  if (values.help) {
    (deps.writeStdout ?? ((text: string) => process.stdout.write(text)))(usage());
    return 0;
  }

  const parsePort = (value: string | undefined) => {
    if (!value) {
      return undefined;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Invalid port: ${value}`);
    }
    return parsed;
  };

  const { runQaDockerUpCommand } = await (deps.loadRuntime ?? loadQaLabRuntime)();

  await runQaDockerUpCommand({
    outputDir: values["output-dir"],
    gatewayPort: parsePort(values["gateway-port"]),
    qaLabPort: parsePort(values["qa-lab-port"]),
    providerBaseUrl: values["provider-base-url"],
    image: values.image,
    usePrebuiltImage: values["use-prebuilt-image"],
    bindUiDist: values["bind-ui-dist"],
    skipUiBuild: values["skip-ui-build"],
  });
  return 0;
}

async function main(argv: readonly string[]): Promise<number> {
  return await runQaLabUp(argv);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
