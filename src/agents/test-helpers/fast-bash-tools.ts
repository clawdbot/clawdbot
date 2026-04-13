import { vi } from "vitest";
import { stubTool } from "./fast-tool-stubs.js";

vi.mock("../bash-tools.js", () => ({
  createExecTool: () => stubTool("exec"),
  createProcessTool: () => stubTool("process"),
}));
