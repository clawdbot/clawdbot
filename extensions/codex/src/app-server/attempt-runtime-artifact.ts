import type { AgentHarnessRuntimeArtifactBinding } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexAppServerClient } from "./client.js";
import { retireSharedCodexAppServerClientIfCurrent } from "./shared-client.js";

export async function verifyStartupArtifact(params: {
  client: CodexAppServerClient;
  request?: Readonly<{ expected?: AgentHarnessRuntimeArtifactBinding }>;
  signal: AbortSignal;
}): Promise<AgentHarnessRuntimeArtifactBinding | undefined> {
  if (!params.request) {
    return undefined;
  }
  const { readCodexAppServerClientRuntimeArtifact, validateCodexAppServerRuntimeArtifact } =
    await import("./runtime-artifact.js");
  const runtimeArtifact = readCodexAppServerClientRuntimeArtifact(params.client);
  const expected = params.request.expected;
  const matchesExpected =
    !expected ||
    (runtimeArtifact?.id === expected.id && runtimeArtifact.fingerprint === expected.fingerprint);
  if (
    !runtimeArtifact ||
    !matchesExpected ||
    !(await validateCodexAppServerRuntimeArtifact(runtimeArtifact, params.signal))
  ) {
    // Never let an unattested physical generation reach Computer Use,
    // plugin discovery, or a native thread request.
    retireSharedCodexAppServerClientIfCurrent(params.client);
    throw new Error(
      expected
        ? "Codex app-server runtime artifact does not match verified inference"
        : "Codex app-server runtime artifact is unavailable or stale",
    );
  }
  return runtimeArtifact;
}
