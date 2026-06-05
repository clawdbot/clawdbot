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
