import { vi } from "vitest";
import { stubTool } from "./fast-tool-stubs.js";

/**
 * Fast Vitest mock for bash tool registration in tests that only need tool inventory.
 */
vi.mock("../bash-tools.js", () => ({
  createExecTool: () => stubTool("exec"),
  createProcessTool: () => stubTool("process"),
}));
