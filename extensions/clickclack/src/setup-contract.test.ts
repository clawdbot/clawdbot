import { describe, expect, it } from "vitest";
import {
  buildClickClackSetupClaimUrl,
  isClickClackSetupLoopbackHost,
  requireClickClackSetupApiBaseUrl,
  requireClickClackSetupClaimUrl,
} from "./setup-contract.js";

describe("ClickClack setup contract", () => {
  it("accepts canonical public API bases and exact claim endpoints", () => {
    for (const apiBaseUrl of [
      "https://api.clickclack.example",
      "https://api.clickclack.example/services/clickclack",
      "http://localhost:8484",
      "http://127.0.0.1:8484/services/clickclack",
      "http://[::1]:8484",
    ]) {
      expect(requireClickClackSetupApiBaseUrl(apiBaseUrl, "API base")).toBe(apiBaseUrl);
      const claimUrl = buildClickClackSetupClaimUrl(apiBaseUrl);
      expect(requireClickClackSetupClaimUrl(claimUrl)).toEqual({ apiBaseUrl, claimUrl });
    }
  });

  it("matches ClickClack's loopback-only HTTP policy", () => {
    for (const hostname of [
      "localhost",
      "LOCALHOST",
      "127.0.0.1",
      "127.255.255.254",
      "::1",
      "::ffff:127.0.0.1",
    ]) {
      expect(isClickClackSetupLoopbackHost(hostname)).toBe(true);
    }
    for (const hostname of ["10.0.0.5", "172.16.0.1", "192.168.1.1", "example.com"]) {
      expect(isClickClackSetupLoopbackHost(hostname)).toBe(false);
    }
  });

  it("rejects non-canonical or unsafe public API bases", () => {
    for (const apiBaseUrl of [
      "http://10.0.0.5",
      "https://api.clickclack.example/",
      "https://api.clickclack.example:443",
      "https://user@api.clickclack.example",
      "https://api.clickclack.example/services//clickclack",
      "https://api.clickclack.example/services/clickclack/",
      "https://api.clickclack.example/services/click%2Fclack",
      "https://api.clickclack.example?next=claim",
      "https://api.clickclack.example#fragment",
    ]) {
      expect(() => requireClickClackSetupApiBaseUrl(apiBaseUrl, "API base")).toThrow();
    }
  });

  it("rejects claim URLs that are not the exact canonical endpoint", () => {
    for (const claimUrl of [
      "https://api.clickclack.example/api/bot-setup-codes/claim/",
      "https://api.clickclack.example/api/bot-setup-codes/claim?next=1",
      "https://api.clickclack.example/api/bot-setup-codes/other",
      "http://10.0.0.5/api/bot-setup-codes/claim",
    ]) {
      expect(() => requireClickClackSetupClaimUrl(claimUrl)).toThrow();
    }
  });
});
