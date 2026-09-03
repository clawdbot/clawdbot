/** Shared CLI runner test doubles for supervisor, bootstrap, and heartbeat seams. */
import type { Mock } from "vitest";
import { beforeEach, vi } from "vitest";
import { setCliRunnerPrepareTestDeps } from "./cli-runner/prepare.test-support.js";
import type { EmbeddedContextFile } from "./embedded-agent-helpers.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";

export {
  createManagedRun,
  enqueueSystemEventMock,
  requestHeartbeatMock,
  supervisorSpawnMock,
} from "./cli-runner/execute.test-support.js";

// Shared CLI runner test doubles. They replace supervisor/process and bootstrap
// dependencies so CLI runner tests can assert process behavior deterministically.
type BootstrapContext = {
  bootstrapFiles: WorkspaceBootstrapFile[];
  contextFiles: EmbeddedContextFile[];
};
type ResolveBootstrapContextForRunMock = Mock<() => Promise<BootstrapContext>>;

const hoisted = vi.hoisted(
  (): {
    resolveBootstrapContextForRunMock: ResolveBootstrapContextForRunMock;
  } => {
    return {
      resolveBootstrapContextForRunMock: vi.fn<() => Promise<BootstrapContext>>(async () => ({
        bootstrapFiles: [],
        contextFiles: [],
      })),
    };
  },
);

setCliRunnerPrepareTestDeps({
  makeBootstrapWarn: () => () => {},
  resolveBootstrapContextForRun: hoisted.resolveBootstrapContextForRunMock,
  resolveOpenClawReferencePaths: async () => ({ docsPath: null, sourcePath: null }),
});

beforeEach(() => {
  vi.unstubAllEnvs();
});
