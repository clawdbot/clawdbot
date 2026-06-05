// Browser tests cover agent.storage plugin behavior.
import { describe, expect, it } from "vitest";
import {
  parseCookieSetOptions,
  parseGeolocationOptions,
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

  describe("parseCookieSetOptions", () => {
    it("parses valid cookie expiry numbers and decimal strings", () => {
      expect(
        parseCookieSetOptions({
          name: "session",
          value: "abc",
          url: "https://example.com",
          expires: "1893456000.5",
          httpOnly: true,
          sameSite: "Lax",
        }),
      ).toEqual({
        name: "session",
        value: "abc",
        url: "https://example.com",
        domain: undefined,
        path: undefined,
        expires: 1893456000.5,
        httpOnly: true,
        secure: undefined,
        sameSite: "Lax",
      });
    });

    it("omits blank optional cookie expiry values", () => {
      expect(parseCookieSetOptions({ name: "session", value: "abc", expires: "  " })).toMatchObject(
        {
          name: "session",
          value: "abc",
          expires: undefined,
        },
      );
    });

    it("rejects loose cookie expiry tokens", () => {
      expect(() =>
        parseCookieSetOptions({ name: "session", value: "abc", expires: "0x10" }),
      ).toThrow("cookie.expires must be a finite number.");
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

  describe("parseGeolocationOptions", () => {
    it("parses valid geolocation numbers and decimal strings", () => {
      expect(
        parseGeolocationOptions({
          latitude: "48.2082",
          longitude: 16.3738,
          accuracy: "12.5",
          origin: " https://example.com ",
        }),
      ).toEqual({
        clear: false,
        latitude: 48.2082,
        longitude: 16.3738,
        accuracy: 12.5,
        origin: "https://example.com",
      });
    });

    it("allows clearing without coordinates", () => {
      expect(
        parseGeolocationOptions({
          clear: true,
          latitude: "",
          longitude: "",
          accuracy: "not-used",
          origin: " https://example.com ",
        }),
      ).toEqual({
        clear: true,
        origin: "https://example.com",
      });
    });

    it("rejects missing coordinates unless clearing", () => {
      expect(() => parseGeolocationOptions({ latitude: 48 })).toThrow(
        "latitude and longitude are required (or set clear=true)",
      );
    });

    it("rejects malformed and out-of-range geolocation numbers", () => {
      expect(() => parseGeolocationOptions({ latitude: "0x10", longitude: 16 })).toThrow(
        "latitude must be a finite number.",
      );
      expect(() => parseGeolocationOptions({ latitude: 91, longitude: 16 })).toThrow(
        "latitude must be between -90 and 90.",
      );
      expect(() => parseGeolocationOptions({ latitude: 48, longitude: -181 })).toThrow(
        "longitude must be between -180 and 180.",
      );
      expect(() => parseGeolocationOptions({ latitude: 48, longitude: 16, accuracy: -1 })).toThrow(
        "accuracy must be non-negative.",
      );
    });
  });
});
