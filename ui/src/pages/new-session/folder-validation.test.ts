import { describe, expect, it } from "vitest";
import { GatewayRequestError } from "../../api/gateway.ts";
import { isMissingRestoredFolderError } from "./folder-validation.ts";

describe("restored new-session folder validation", () => {
  it.each(["ENOENT: no such file or directory", "Error: ENOTDIR: not a directory"])(
    "recognizes a definitive stale path from %s",
    (message) => {
      expect(
        isMissingRestoredFolderError(new GatewayRequestError({ code: "INVALID_REQUEST", message })),
      ).toBe(true);
    },
  );

  it("keeps transient and unrelated request failures recoverable", () => {
    expect(
      isMissingRestoredFolderError(
        new GatewayRequestError({ code: "UNAVAILABLE", message: "gateway restarting" }),
      ),
    ).toBe(false);
    expect(
      isMissingRestoredFolderError(
        new GatewayRequestError({ code: "INVALID_REQUEST", message: "EACCES: permission denied" }),
      ),
    ).toBe(false);
    expect(
      isMissingRestoredFolderError(
        new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "Error: EACCES: permission denied, scandir '/work/: ENOENT:/project'",
        }),
      ),
    ).toBe(false);
  });
});
