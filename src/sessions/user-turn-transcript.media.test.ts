// User-turn media persistence tests cover fact normalization and legacy row projection.
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPersistedUserTurnMediaInputsFromFields,
  buildPersistedUserTurnMessage,
} from "./user-turn-transcript.js";

describe("buildPersistedUserTurnMediaInputsFromFields", () => {
  it("builds media facts from persisted parallel fields", () => {
    expect(
      buildPersistedUserTurnMediaInputsFromFields({
        MediaPath: "/tmp/a.png",
        MediaPaths: ["/tmp/a.png", "/tmp/b.jpg"],
        MediaType: "image/png",
        MediaTypes: ["image/png", "image/jpeg"],
      }),
    ).toEqual([
      { path: "/tmp/a.png", contentType: "image/png" },
      { path: "/tmp/b.jpg", contentType: "image/jpeg" },
    ]);
  });

  it("uses url-backed media fields when no local path is present", () => {
    expect(
      buildPersistedUserTurnMediaInputsFromFields({
        MediaUrl: "media://inbound/a.png",
        MediaType: "image/png",
      }),
    ).toEqual([{ url: "media://inbound/a.png", contentType: "image/png" }]);
  });

  it("infers transcript media type from media path when explicit type is absent", () => {
    expect(
      buildPersistedUserTurnMediaInputsFromFields({
        MediaPaths: ["/tmp/a.png", "https://example.test/report.pdf"],
      }),
    ).toEqual([
      { path: "/tmp/a.png", contentType: "image/png" },
      { path: "https://example.test/report.pdf", contentType: "application/pdf" },
    ]);
  });

  it("does not reuse singular media type for later media paths", () => {
    expect(
      buildPersistedUserTurnMediaInputsFromFields({
        MediaPath: "/tmp/a.png",
        MediaPaths: ["/tmp/a.png", "/tmp/report.pdf"],
        MediaType: "image/png",
      }),
    ).toEqual([
      { path: "/tmp/a.png", contentType: "image/png" },
      { path: "/tmp/report.pdf", contentType: "application/pdf" },
    ]);
  });

  it("resolves staged legacy paths against the media workspace", () => {
    const workspaceDir = "/tmp/openclaw-user-turn-workspace";
    expect(
      buildPersistedUserTurnMediaInputsFromFields({
        MediaPaths: ["media/inbound/a.png", "media/inbound/b.jpg"],
        MediaTypes: ["image/png", "image/jpeg"],
        MediaWorkspaceDir: workspaceDir,
      }),
    ).toEqual([
      { path: path.join(workspaceDir, "media/inbound/a.png"), contentType: "image/png" },
      { path: path.join(workspaceDir, "media/inbound/b.jpg"), contentType: "image/jpeg" },
    ]);
  });

  it("does not rewrite absolute or URL-like media paths", () => {
    const workspaceDir = "/tmp/openclaw-user-turn-workspace";
    const absolutePath = path.join(workspaceDir, "media/inbound/a.png");
    expect(
      buildPersistedUserTurnMediaInputsFromFields({
        MediaPaths: [absolutePath, "media://inbound/b.jpg", "https://example.test/c.png"],
        MediaTypes: ["image/png", "image/jpeg", "image/png"],
        MediaWorkspaceDir: workspaceDir,
      }),
    ).toEqual([
      { path: absolutePath, contentType: "image/png" },
      { path: "media://inbound/b.jpg", contentType: "image/jpeg" },
      { path: "https://example.test/c.png", contentType: "image/png" },
    ]);
  });

  it("does not infer media from absent structured fields", () => {
    expect(buildPersistedUserTurnMediaInputsFromFields(undefined)).toEqual([]);
    expect(buildPersistedUserTurnMediaInputsFromFields({})).toEqual([]);
    expect(buildPersistedUserTurnMediaInputsFromFields({ MediaTypes: ["image/png"] })).toEqual([]);
  });

  it("preserves aligned content-type holes while normalizing the row", () => {
    const result = buildPersistedUserTurnMediaInputsFromFields({
      MediaPaths: ["/media/a.bin", "/media/b.png"],
      MediaTypes: ["", "image/png"],
    });
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ path: "/media/a.bin" });
    expect(result[0]?.contentType).not.toBe("image/png");
    expect(result[1]).toEqual({ path: "/media/b.png", contentType: "image/png" });
  });

  it("preserves aligned path and URL holes while normalizing the row", () => {
    expect(
      buildPersistedUserTurnMediaInputsFromFields({
        MediaPaths: ["/media/local.bin", ""],
        MediaUrls: ["", "https://example.test/remote.png"],
        MediaTypes: ["application/octet-stream", "image/png"],
      }),
    ).toEqual([
      { path: "/media/local.bin", contentType: "application/octet-stream" },
      { url: "https://example.test/remote.png", contentType: "image/png" },
    ]);
  });

  it("keeps empty attachment slots aligned for a later writer", () => {
    expect(
      buildPersistedUserTurnMediaInputsFromFields({
        MediaPaths: ["", "/media/b.png"],
        MediaTypes: ["", "image/png"],
      }),
    ).toEqual([{}, { path: "/media/b.png", contentType: "image/png" }]);
  });
});

describe("buildPersistedUserTurnMessage media projection", () => {
  it.each([
    {
      name: "one attachment",
      media: [{ path: "/tmp/a.png", contentType: "image/png" }],
      expected: {
        role: "user",
        content: "inspect",
        timestamp: 123,
        MediaPath: "/tmp/a.png",
        MediaPaths: ["/tmp/a.png"],
        MediaType: "image/png",
        MediaTypes: ["image/png"],
      },
    },
    {
      name: "many attachments",
      media: [
        { path: " /tmp/a.png ", contentType: " image/png " },
        { url: " https://example.test/report.pdf ", contentType: " application/pdf " },
      ],
      expected: {
        role: "user",
        content: "inspect",
        timestamp: 123,
        MediaPath: "/tmp/a.png",
        MediaPaths: ["/tmp/a.png", "https://example.test/report.pdf"],
        MediaType: "image/png",
        MediaTypes: ["image/png", "application/pdf"],
      },
    },
  ])("keeps $name row bytes stable", ({ media, expected }) => {
    const message = buildPersistedUserTurnMessage({ text: "inspect", timestamp: 123, media });
    expect(message).toEqual(expected);
    expect(JSON.stringify(message)).toBe(JSON.stringify(expected));
  });

  it("uses the aligned storage projection when an earlier fact has no path", () => {
    const message = buildPersistedUserTurnMessage({
      text: "inspect",
      timestamp: 123,
      media: [{ kind: "image" }, { path: "/tmp/b.png", contentType: "image/png" }],
    });
    expect(message).toEqual({
      role: "user",
      content: "inspect",
      timestamp: 123,
      MediaPaths: ["", "/tmp/b.png"],
      MediaTypes: ["", "image/png"],
    });
  });
});
