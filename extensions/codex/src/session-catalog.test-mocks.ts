import { vi, type Mock } from "vitest";

const commandRpcMocks = vi.hoisted(() => ({
  codexControlRequest: vi.fn() as Mock,
}));
const pinnedConnectionMocks = vi.hoisted(() => ({
  client: { connectionId: "pinned-catalog-client" },
  getClient: vi.fn() as Mock,
  releaseClient: vi.fn() as Mock,
  request: vi.fn() as Mock,
}));
const transcriptMirrorMocks = vi.hoisted(() => ({
  importCodexThreadHistoryToTranscript: vi.fn(async () => ({
    importedMessages: 0,
    omittedMessages: 0,
  })),
}));
const nodeHostMocks = vi.hoisted(() => ({
  runNodePtyCommand: vi.fn(async () => ({ exitCode: 0 })),
  userShellPaths: new Map<string, string>(),
}));

vi.mock("./command-rpc.js", () => ({
  codexControlRequest: commandRpcMocks.codexControlRequest,
}));
vi.mock("./app-server/request.js", () => ({
  requestCodexAppServerClientJson: pinnedConnectionMocks.request,
}));
vi.mock("./app-server/shared-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./app-server/shared-client.js")>()),
  getLeasedSharedCodexAppServerClient: pinnedConnectionMocks.getClient,
  releaseLeasedSharedCodexAppServerClient: pinnedConnectionMocks.releaseClient,
}));
vi.mock("./app-server/transcript-mirror.js", () => ({
  importCodexThreadHistoryToTranscript: transcriptMirrorMocks.importCodexThreadHistoryToTranscript,
}));
vi.mock("./session-catalog-pty.runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-catalog-pty.runtime.js")>();
  return {
    ...actual,
    runNodePtyCommand: nodeHostMocks.runNodePtyCommand,
    resolveNodeHostExecutable: (
      command: string,
      options: {
        env?: NodeJS.ProcessEnv;
        pathEnv?: string;
        includeExtensionless?: boolean;
        strategy: "direct" | "fallback" | "prefer";
      },
    ) => {
      const env = options.env ?? process.env;
      const pathEnv = options.pathEnv ?? env.PATH ?? env.Path ?? "";
      const direct = actual.resolveNodeHostExecutable(command, {
        env,
        pathEnv,
        includeExtensionless: options.includeExtensionless,
        strategy: "direct",
      });
      if (direct && options.strategy !== "prefer") {
        return direct;
      }
      const shellPath = nodeHostMocks.userShellPaths.get(command);
      if (!shellPath) {
        return direct;
      }
      const shellExecutable = actual.resolveNodeHostExecutable(command, {
        env,
        pathEnv: shellPath,
        includeExtensionless: options.includeExtensionless,
        strategy: "direct",
      });
      return shellExecutable
        ? { executable: shellExecutable.executable, pathEnv: shellPath }
        : direct;
    },
  };
});

export { commandRpcMocks, pinnedConnectionMocks, transcriptMirrorMocks, nodeHostMocks };
