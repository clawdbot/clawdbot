/**
 * Fast bash-tool registration mock for tests.
 *
 * Replaces exec/process tools with lightweight stubs when only inventory shape matters.
 */
import { vi } from "vitest";
import { stubTool } from "./fast-tool-stubs.js";

vi.mock("../bash-tools.js", () => ({
  createExecTool: () => stubTool("exec"),
  createProcessTool: () => stubTool("process"),
}));
