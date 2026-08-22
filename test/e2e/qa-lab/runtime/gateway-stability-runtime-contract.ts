// Pure CLI contract shared by the Gateway stability script and fast unit coverage.
import path from "node:path";

export type GatewayStabilityRuntimeOptions = {
  artifactBase: string;
  repoRoot: string;
};

export function parseGatewayStabilityRuntimeOptions(
  argv: readonly string[],
  repoRoot = process.cwd(),
): GatewayStabilityRuntimeOptions {
  let artifactBase: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const value = argv[index + 1];
    if (option !== "--artifact-base") {
      throw new Error(`unknown argument: ${option}`);
    }
    if (!value || value.startsWith("--")) {
      throw new Error("--artifact-base requires a value");
    }
    artifactBase = value;
    index += 1;
  }
  if (!artifactBase) {
    throw new Error("--artifact-base is required");
  }
  return { artifactBase: path.resolve(repoRoot, artifactBase), repoRoot };
}
