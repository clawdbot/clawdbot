// Bind spec tests cover parsing host/container/options segments for Docker
// bind mounts, including Windows drive-letter hosts.
import { describe, expect, it } from "vitest";
import { splitSandboxBindSpec } from "./bind-spec.js";

describe("splitSandboxBindSpec", () => {
  it("splits POSIX bind specs with and without mode", () => {
    expect(splitSandboxBindSpec("/tmp/a:/workspace-a:ro")).toEqual({
      host: "/tmp/a",
      container: "/workspace-a",
      options: "ro",
    });
    expect(splitSandboxBindSpec("/tmp/b:/workspace-b")).toEqual({
      host: "/tmp/b",
      container: "/workspace-b",
      options: "",
    });
  });

  it("preserves Windows drive-letter host paths", () => {
    // The colon after a drive letter is not the host/container separator.
    expect(splitSandboxBindSpec("C:\\Users\\kai\\workspace:/workspace:ro")).toEqual({
      host: "C:\\Users\\kai\\workspace",
      container: "/workspace",
      options: "ro",
    });
  });

  it("returns null when no host/container separator exists", () => {
    expect(splitSandboxBindSpec("/tmp/no-separator")).toBeNull();
  });

  it("keeps Windows container drive handling opt-in", () => {
    expect(splitSandboxBindSpec("C:\\host:D:\\container:ro")).toEqual({
      host: "C:\\host",
      container: "D",
      options: "\\container:ro",
    });
  });

  it.each([
    { container: "D:\\container", suffix: ":ro", options: "ro" },
    { container: "D:/container", suffix: "", options: "" },
    { container: "D:/container", suffix: ":RW, ro", options: "RW, ro" },
  ])("preserves opted-in container path $container$suffix", ({ container, suffix, options }) => {
    expect(
      splitSandboxBindSpec(`C:\\host:${container}${suffix}`, { allowWindowsContainerPath: true }),
    ).toEqual({ host: "C:\\host", container, options });
  });
});
