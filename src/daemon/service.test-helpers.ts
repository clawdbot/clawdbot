/** Test helpers for exercising generic daemon service orchestration. */
import os from "node:os";
import { vi } from "vitest";
import type { GatewayService } from "./service.js";

// Keep OS-account fixtures out of the SDK-exposed spy barrel: node:os mock factories
// import that barrel, so importing node:os there would deadlock test collection.
/** Keep service policy real while giving isolated HOME scopes an OS account identity. */
export function mockSystemAccountHome(): void {
  const account = os.userInfo();
  // Native OS home APIs read the parent environment in Node worker threads.
  const homedir = () => process.env.HOME ?? account.homedir;
  vi.spyOn(os, "homedir").mockImplementation(homedir);
  vi.spyOn(os, "userInfo").mockImplementation(() => ({ ...account, homedir: homedir() }));
}

export type SystemdManagerSnapshotFixture = {
  programArguments: string[];
  workingDirectory?: string;
  environment?: string[];
  environmentFiles?: Array<[string, boolean]>;
  unsetEnvironment?: string[];
  fragmentPath?: string;
  dropInPaths?: string[];
  needDaemonReload?: boolean;
  loadState?: string;
};

export function buildSystemdManagerPropertyOutput(snapshot: SystemdManagerSnapshotFixture): string {
  return [
    {
      type: "a(sasbttttuii)",
      data: [[snapshot.programArguments[0], snapshot.programArguments, false, 0, 0, 0, 0, 0, 0, 0]],
    },
    { type: "s", data: snapshot.workingDirectory ?? "" },
    { type: "as", data: snapshot.environment ?? [] },
    { type: "a(sb)", data: snapshot.environmentFiles ?? [] },
    { type: "as", data: snapshot.unsetEnvironment ?? [] },
  ]
    .map((property) => JSON.stringify(property))
    .join("\n");
}

export function buildSystemdUnitPropertyOutput(
  params: Pick<SystemdManagerSnapshotFixture, "dropInPaths" | "needDaemonReload" | "loadState"> & {
    fragmentPath: string;
  },
): string {
  return [
    JSON.stringify({ type: "s", data: params.fragmentPath }),
    JSON.stringify({ type: "as", data: params.dropInPaths ?? [] }),
    JSON.stringify({ type: "b", data: params.needDaemonReload ?? false }),
    JSON.stringify({ type: "s", data: params.loadState ?? "loaded" }),
  ].join("\n");
}

/** Creates a mock gateway service implementation for daemon service tests. */
export function createMockGatewayService(overrides: Partial<GatewayService> = {}): GatewayService {
  return {
    label: "LaunchAgent",
    loadedText: "loaded",
    notLoadedText: "not loaded",
    stage: vi.fn(async () => {}),
    install: vi.fn(async () => {}),
    uninstall: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    restart: vi.fn(async () => ({ outcome: "completed" as const })),
    isLoaded: vi.fn(async () => false),
    readCommand: vi.fn(async () => null),
    readRuntime: vi.fn(async () => ({ status: "stopped" as const })),
    ...overrides,
  };
}
