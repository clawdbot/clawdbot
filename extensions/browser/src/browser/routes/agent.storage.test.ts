import { describe, expect, it } from "vitest";
import {
  parseRequiredStorageMutationRequest,
  parseStorageKind,
  parseStorageMutationRequest,
} from "./agent.storage.js";

describe("browser storage route parsing", () => {
  describe("parseStorageKind", () => {
    it("accepts local and session", () => {
      expect(parseStorageKind("local")).toBe("local");
      expect(parseStorageKind("session")).toBe("session");
    });

    it("rejects unsupported values", () => {
      expect(parseStorageKind("cookie")).toBeNull();
      expect(parseStorageKind("")).toBeNull();
    });
  });

  describe("parseStorageMutationRequest", () => {
    it("returns parsed kind and trimmed target id", () => {
      expect(
        parseStorageMutationRequest("local", {
          targetId: "  page-1  ",
        }),
      ).toEqual({
        kind: "local",
        targetId: "page-1",
      });
    });

    it("returns null kind and undefined target id for invalid values", () => {
      expect(
        parseStorageMutationRequest("invalid", {
          targetId: "   ",
        }),
      ).toEqual({
        kind: null,
        targetId: undefined,
      });
    });
  });

  describe("parseRequiredStorageMutationRequest", () => {
    it("returns parsed request for supported kinds", () => {
      expect(
        parseRequiredStorageMutationRequest("session", {
          targetId: " tab-9 ",
        }),
      ).toEqual({
        kind: "session",
        targetId: "tab-9",
      });
    });

    it("returns null for unsupported kind", () => {
      expect(
        parseRequiredStorageMutationRequest("cookie", {
          targetId: "tab-1",
        }),
      ).toBeNull();
    });
  });
});
