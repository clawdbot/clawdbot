import { describe, expect, it } from "vitest";
import { isLikelyDiscordVideoMedia } from "./media-detection.js";

describe("isLikelyDiscordVideoMedia", () => {
  it.each([
    ["plain local path", "/tmp/render.MP4?download=1", true],
    ["encoded extension dot", "https://cdn.example/render%2Emp4?download=1", true],
    ["encoded extension characters", "https://cdn.example/render%2Em%70%34", true],
    ["malformed earlier segment", "https://cdn.example/bad%ZZ/render%2Emp4", true],
    ["encoded suffix after extension", "https://cdn.example/render.mp4%2Fpreview", false],
    ["double-encoded dot", "https://cdn.example/render%252Emp4", false],
    ["non-video extension", "https://cdn.example/render%2Ejpg", false],
  ])("classifies %s", (_name, mediaUrl, expected) => {
    expect(isLikelyDiscordVideoMedia(mediaUrl)).toBe(expected);
  });
});
