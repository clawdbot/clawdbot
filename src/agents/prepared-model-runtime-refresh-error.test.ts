import { describe, expect, it } from "vitest";
import { formatRuntimeRefreshError } from "./prepared-model-runtime-refresh-error.js";

describe("formatRuntimeRefreshError", () => {
  it("bounds and redacts nested aggregate causes", () => {
    const token = "sk-abcdefghijklmnopqrstuvwxyz";
    const sqliteError = Object.assign(new Error("simulated SQLite read failure"), {
      code: "SQLITE_IOERR",
    });
    const refreshError = new AggregateError(
      [
        new Error("main auth store unreadable", { cause: sqliteError }),
        new Error(`Authorization: Bearer ${token}`),
      ],
      "configured auth owners failed",
    );

    const message = formatRuntimeRefreshError(refreshError);

    expect(message).toContain("configured auth owners failed");
    expect(message).toContain("main auth store unreadable");
    expect(message).toContain("simulated SQLite read failure");
    expect(message).toContain("SQLITE_IOERR");
    expect(message).not.toContain(token);
    expect(message.length).toBeLessThanOrEqual(2_100);
  });
});
