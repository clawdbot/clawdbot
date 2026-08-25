import { describe, expect, it } from "vitest";
import { classifyTailscaleLogin } from "./user-profiles-tailscale-login.js";

describe("Tailscale profile login classification", () => {
  it.each([
    ["user@github", { kind: "provider", provider: "github", subject: "user" }],
    ["USER@PASSKEY", { kind: "provider", provider: "passkey", subject: "user" }],
    ["person@gmail.com", { kind: "email", email: "person@gmail.com" }],
    ["person@alias@gmail.com", { kind: "email", email: "person@alias@gmail.com" }],
    ["usér@github", { kind: "provider", provider: "github", subject: "usér" }],
    ["person@例え.テスト", { kind: "email", email: "person@例え.テスト" }],
    ["", { kind: "invalid" }],
    ["missing-at", { kind: "invalid" }],
    ["@github", { kind: "invalid" }],
    ["user@", { kind: "invalid" }],
  ])("classifies %j", (login, expected) => {
    expect(classifyTailscaleLogin(login)).toEqual(expected);
  });
});
