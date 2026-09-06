/** Runtime-probe and systemctl mocks for daemon service-audit tests. */
import { vi } from "vitest";
import { execSystemctlUserMock, resolveBunRuntimeInfoMock } from "./service-audit-fixtures.js";

vi.mock("../runtime-paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime-paths.js")>()),
  resolveBunRuntimeInfo: resolveBunRuntimeInfoMock,
}));

vi.mock("../systemd-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../systemd-exec.js")>()),
  execSystemctlUser: execSystemctlUserMock,
}));
