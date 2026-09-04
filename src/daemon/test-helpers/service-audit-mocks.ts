/** Runtime-probe and systemctl mocks for daemon service-audit tests. */
import { vi } from "vitest";
import { execSystemctlUser, resolveBunRuntimeInfo } from "./service-audit-fixtures.js";

vi.mock("../runtime-paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime-paths.js")>()),
  resolveBunRuntimeInfo,
}));

vi.mock("../systemd-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../systemd-exec.js")>()),
  execSystemctlUser,
}));
