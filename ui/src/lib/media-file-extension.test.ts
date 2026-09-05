// @vitest-environment node
// Control UI tests cover browser-safe media extension parsing.
import { describe, expect, it } from "vitest";
import { getMediaFileExtension } from "./media-file-extension.ts";

describe("getMediaFileExtension", () => {
  it.each([
    { value: "https://cdn.example/render%2Emp4?download=1#preview", expected: "mp4" },
    { value: "https://cdn.example/render%2Em%70%34", expected: "mp4" },
    { value: "/media/inbound/photo.png?mediaTicket=signed#preview", expected: "png" },
    { value: "/__openclaw__/media/voice%2Eogg?mediaTicket=signed", expected: "ogg" },
    { value: "/media/inbound/photo.png?preview=.jpg", expected: "png" },
    { value: "/tmp/recording?download=.mp3", expected: "mp3" },
    { value: "/tmp/clip#final.mp4", expected: "mp4" },
    { value: "https://cdn.example/bad%ZZ/render%2Emp4", expected: "mp4" },
    { value: "https://cdn.example/archive%2Fclip%2Emp4", expected: "mp4" },
    { value: "https://cdn.example/archive%5Cclip%2Emp4", expected: "mp4" },
    { value: "https://cdn.example/render.mp4%2Fpreview", expected: undefined },
    { value: "https://cdn.example/render.mp4%5Cpreview", expected: undefined },
    { value: "https://cdn.example/bad%ZZ%2Emp4", expected: undefined },
    { value: "https://cdn.example/render%2Emp4/", expected: undefined },
    { value: String.raw`C:\media\clip.MP4`, expected: "mp4" },
  ] as const)("extracts $expected from $value", ({ value, expected }) => {
    expect(getMediaFileExtension(value)).toBe(expected);
  });
});
