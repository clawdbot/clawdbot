import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  mapCodexAppServerLocalWorkspacePath,
  mapCodexAppServerRemoteWorkspacePath,
} from "./remote-workspace-path.js";

const localWorkspaceRoot = path.resolve("gateway-workspace");
const remoteWorkspaceRoot = "/remote/codex-workspace";

describe("Codex remote workspace paths", () => {
  it("maps a gateway workspace artifact into the remote execution workspace", () => {
    expect(
      mapCodexAppServerRemoteWorkspacePath({
        value: path.join(localWorkspaceRoot, "reports", "slack-upload.txt"),
        localWorkspaceRoot,
        remoteWorkspaceRoot,
      }),
    ).toBe(`${remoteWorkspaceRoot}/reports/slack-upload.txt`);
  });

  it("maps a remote workspace artifact into the gateway workspace", () => {
    expect(
      mapCodexAppServerLocalWorkspacePath({
        value: `${remoteWorkspaceRoot}/reports/slack-upload.txt`,
        localWorkspaceRoot,
        remoteWorkspaceRoot,
      }),
    ).toBe(path.join(localWorkspaceRoot, "reports", "slack-upload.txt"));
  });

  it("preserves URL-backed and managed media sources", () => {
    for (const value of [
      "https://example.com/image.png",
      "mxc://example.org/image",
      "buffer://generated-image",
      "media://inbound/image.png",
      "data:image/png;base64,aGVsbG8=",
    ]) {
      expect(
        mapCodexAppServerLocalWorkspacePath({ value, localWorkspaceRoot, remoteWorkspaceRoot }),
      ).toBe(value);
    }
  });

  it("maps workspace-relative media into the gateway workspace", () => {
    expect(
      mapCodexAppServerLocalWorkspacePath({
        value: "reports/slack-upload.txt",
        localWorkspaceRoot,
        remoteWorkspaceRoot,
      }),
    ).toBe(path.join(localWorkspaceRoot, "reports", "slack-upload.txt"));
  });

  it("normalizes harmless relative and nested dot segments", () => {
    for (const value of [
      "./reports/slack-upload.txt",
      "reports/./slack-upload.txt",
      `${remoteWorkspaceRoot}/reports/./slack-upload.txt`,
    ]) {
      expect(
        mapCodexAppServerLocalWorkspacePath({ value, localWorkspaceRoot, remoteWorkspaceRoot }),
      ).toBe(path.join(localWorkspaceRoot, "reports", "slack-upload.txt"));
    }
  });

  it("matches Windows remote workspace roots without depending on path casing", () => {
    expect(
      mapCodexAppServerLocalWorkspacePath({
        value: "c:\\work\\repo\\Reports\\Upload.TXT",
        localWorkspaceRoot,
        remoteWorkspaceRoot: "C:\\Work\\Repo",
      }),
    ).toBe(path.join(localWorkspaceRoot, "Reports", "Upload.TXT"));
  });

  it("preserves case-insensitive Windows drive-root workspace paths", () => {
    expect(
      mapCodexAppServerLocalWorkspacePath({
        value: "c:\\Reports\\Upload.TXT",
        localWorkspaceRoot,
        remoteWorkspaceRoot: "C:\\",
      }),
    ).toBe(path.join(localWorkspaceRoot, "Reports", "Upload.TXT"));
  });

  it("projects gateway artifacts into Windows drive roots without duplicate slashes", () => {
    expect(
      mapCodexAppServerRemoteWorkspacePath({
        value: path.join(localWorkspaceRoot, "reports", "upload.txt"),
        localWorkspaceRoot,
        remoteWorkspaceRoot: "C:\\",
      }),
    ).toBe("C:/reports/upload.txt");
  });

  it("continues rejecting case-insensitive Windows sibling paths", () => {
    expect(() =>
      mapCodexAppServerLocalWorkspacePath({
        value: "c:\\work\\repo-other\\private.txt",
        localWorkspaceRoot,
        remoteWorkspaceRoot: "C:\\Work\\Repo",
      }),
    ).toThrow("outside");
  });

  it("rejects remote sibling and gateway-local filesystem paths", () => {
    for (const value of [
      `${remoteWorkspaceRoot}-other/report.txt`,
      "/etc/passwd",
      path.join(localWorkspaceRoot, "private.txt"),
      "file:///etc/passwd",
    ]) {
      expect(() =>
        mapCodexAppServerLocalWorkspacePath({ value, localWorkspaceRoot, remoteWorkspaceRoot }),
      ).toThrow("outside");
    }
  });

  it("rejects traversal inside a claimed remote workspace artifact", () => {
    expect(() =>
      mapCodexAppServerLocalWorkspacePath({
        value: `${remoteWorkspaceRoot}/reports/../../private.txt`,
        localWorkspaceRoot,
        remoteWorkspaceRoot,
      }),
    ).toThrow("must stay inside");
  });

  it("preserves workspace paths when no remote root is configured", () => {
    const value = path.join(localWorkspaceRoot, "report.txt");
    expect(mapCodexAppServerRemoteWorkspacePath({ value, localWorkspaceRoot })).toBe(value);
    expect(mapCodexAppServerLocalWorkspacePath({ value, localWorkspaceRoot })).toBe(value);
  });

  it("continues rejecting gateway working directories outside the workspace", () => {
    expect(() =>
      mapCodexAppServerRemoteWorkspacePath({
        value: path.resolve("outside-workspace", "report.txt"),
        localWorkspaceRoot,
        remoteWorkspaceRoot,
      }),
    ).toThrow("outside OpenClaw workspace root");
  });
});
