import { describe, expect, it, vi } from "vitest";
import { hostingProfilesInspectCommand, hostingProfilesListCommand } from "./hosting-profiles.js";

function createRuntime() {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
}

describe("hosting profile catalog commands", () => {
  it("lists the standard catalog as stable JSON", () => {
    const runtime = createRuntime();

    hostingProfilesListCommand({ json: true }, runtime);

    const result = JSON.parse(runtime.log.mock.calls[0]?.[0] ?? "{}") as {
      contractVersion?: number;
      profiles?: Array<{ id: string; profileConditions: string[] }>;
    };
    expect(result.contractVersion).toBe(1);
    expect(result.profiles?.map((profile) => profile.id)).toEqual([
      "local",
      "container",
      "reverse-proxy",
      "node-mode",
    ]);
    expect(
      result.profiles?.find((profile) => profile.id === "container")?.profileConditions,
    ).toEqual(["ProfileSelected", "ContainerStateReady"]);
  });

  it("renders a concise human catalog", () => {
    const runtime = createRuntime();

    hostingProfilesListCommand({}, runtime);

    const output = runtime.log.mock.calls[0]?.[0] ?? "";
    expect(output).toContain("PROFILE");
    expect(output).toContain("reverse-proxy");
    expect(output).toContain("Gateway behind a trusted identity proxy.");
  });

  it("inspects one profile with conditions and criteria", () => {
    const runtime = createRuntime();

    hostingProfilesInspectCommand("node-mode", {}, runtime);

    const output = runtime.log.mock.calls[0]?.[0] ?? "";
    expect(output).toContain("Profile: node-mode");
    expect(output).toContain("- NodePairingReady");
    expect(output).toContain("- openclaw.model-route-ready");
    expect(output).toContain("- openclaw.scheduler-ready");
  });

  it("returns one descriptor as stable JSON", () => {
    const runtime = createRuntime();

    hostingProfilesInspectCommand("container", { json: true }, runtime);

    const result = JSON.parse(runtime.log.mock.calls[0]?.[0] ?? "{}") as {
      contractVersion?: number;
      profile?: { id?: string; description?: string };
    };
    expect(result).toMatchObject({
      contractVersion: 1,
      profile: {
        id: "container",
        description: "Gateway directly reachable through a container listener.",
      },
    });
  });

  it("rejects an unknown profile without emitting a partial descriptor", () => {
    const runtime = createRuntime();

    hostingProfilesInspectCommand("managed", { json: true }, runtime);

    expect(runtime.log).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(
      'Unknown hosting profile "managed". Use "local", "container", "reverse-proxy", "node-mode".',
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
