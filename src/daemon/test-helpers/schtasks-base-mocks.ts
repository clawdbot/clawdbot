/** Base Vitest mocks for Windows schtasks daemon tests. */
import { vi } from "vitest";
import {
  inspectPortUsage,
  killProcessTree,
  schtasksCalls,
  schtasksResponses,
} from "./schtasks-fixtures.js";

// Shared Windows schtasks mocks for daemon tests.
vi.mock("../schtasks-exec.js", () => ({
  execSchtasks: async (argv: string[]) => {
    schtasksCalls.push(argv);
    return schtasksResponses.shift() ?? { code: 0, stdout: "", stderr: "" };
  },
}));

vi.mock("../../infra/ports.js", () => ({
  inspectPortUsage: (port: number) => inspectPortUsage(port),
}));

vi.mock("../../process/kill-tree.js", () => ({
  killProcessTree: (pid: number, opts?: { graceMs?: number }) => killProcessTree(pid, opts),
}));

// Launcher encode/decode must not depend on the dev or CI machine's code page;
// unpinned, a non-UTF-8-locale Windows host would OEM-encode fixture launcher files.
vi.mock("../../infra/windows-encoding.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/windows-encoding.js")>(
    "../../infra/windows-encoding.js",
  );
  return {
    ...actual,
    resolveWindowsOemCodePage: () => 437,
    resolveWindowsOemEncoding: () => "cp437",
  };
});
