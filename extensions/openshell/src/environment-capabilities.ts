import type {
  SandboxBackendCommandParams,
  SandboxBackendCommandResult,
  SandboxCapabilityRootDiscovery,
  SandboxCapabilityRootRequest,
} from "openclaw/plugin-sdk/sandbox";

const MAX_MCP_CONFIG_BYTES = 256 * 1024;

const DISCOVER_MCP_CONFIG_SCRIPT = String.raw`
set -eu
python_bin=$(command -v python3 || command -v python)
"$python_bin" -c '
import base64, pathlib, sys

file = pathlib.Path(sys.argv[1]) / ".mcp.json"
if file.is_file():
    data = file.read_bytes()
    if len(data) > ${MAX_MCP_CONFIG_BYTES}:
        print("oversized\t" + str(len(data)))
    else:
        print("config\t" + base64.b64encode(data).decode("ascii"))
' "$1"
`;

type RunEnvironmentCommand = (
  params: SandboxBackendCommandParams,
) => Promise<SandboxBackendCommandResult>;

export async function discoverOpenShellCapabilityRoots(params: {
  roots: readonly SandboxCapabilityRootRequest[];
  signal?: AbortSignal;
  runCommand: RunEnvironmentCommand;
}): Promise<SandboxCapabilityRootDiscovery[]> {
  const results: SandboxCapabilityRootDiscovery[] = [];
  for (const root of params.roots) {
    const result = await params.runCommand({
      script: DISCOVER_MCP_CONFIG_SCRIPT,
      args: [root.path],
      signal: params.signal,
    });
    if (result.code !== 0) {
      results.push({
        id: root.id,
        path: root.path,
        error: result.stderr.toString("utf8").trim() || "capability discovery failed",
      });
      continue;
    }
    const line = result.stdout.toString("utf8").trim();
    if (!line) {
      results.push({ id: root.id, path: root.path });
      continue;
    }
    const [kind, value] = line.split("\t", 2);
    if (kind === "oversized") {
      results.push({
        id: root.id,
        path: root.path,
        warnings: [`.mcp.json exceeds ${MAX_MCP_CONFIG_BYTES} bytes (${value ?? "unknown"})`],
      });
      continue;
    }
    if (kind !== "config" || !value) {
      results.push({ id: root.id, path: root.path, error: "invalid discovery response" });
      continue;
    }
    const contents = Buffer.from(value, "base64").toString("utf8");
    results.push({
      id: root.id,
      path: root.path,
      mcpConfig: { path: `${root.path}/.mcp.json`, contents },
    });
  }
  return results;
}
