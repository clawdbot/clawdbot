import { afterEach, describe, expect, it, vi } from "vitest";

const { prepare } = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock("./sqlite-readonly-location.js", () => ({
  prepareSqliteReadOnlyLocationInProcess: prepare,
  prepareSqliteReadOnlyLocationSyncInProcess: prepare,
}));

const originalArgv = process.argv;
const originalExitCode = process.exitCode;
afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  prepare.mockReset();
  vi.resetModules();
});

async function expectWorkerFailure(error: unknown, message: string): Promise<void> {
  process.argv = [
    process.execPath,
    "sqlite-readonly-location.worker.ts",
    "--openclaw-sqlite-readonly-child",
    "async",
    "/synthetic/database.sqlite",
  ];
  const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  prepare.mockRejectedValueOnce(error);
  await import("./sqlite-readonly-location.worker.js");
  await vi.dynamicImportSettled();
  expect(write).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ ok: false, message }));
  expect(process.exitCode).toBe(1);
}

describe("SQLite read-only worker diagnostics", () => {
  it.each([
    { error: new Error(""), message: "" },
    { error: "plain failure", message: "plain failure" },
    { error: null, message: "null" },
    { error: undefined, message: "undefined" },
    { error: { message: "hidden structured message" }, message: "[object Object]" },
  ])("preserves the original top-level message: $message", async ({ error, message }) => {
    await expectWorkerFailure(error, message);
  });

  it("deduplicates cyclic cause codes without exposing other error details", async () => {
    const error = Object.assign(new Error("disk I/O error"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 778,
      errstr: "hidden errstr",
      stack: "hidden stack",
      sql: "hidden SQL",
      data: { code: "HIDDEN_DATA" },
      errors: [{ code: "HIDDEN_AGGREGATE" }],
    });
    error.cause = Object.assign(new Error("hidden cause message", { cause: error }), {
      code: "ERR_SQLITE_ERROR",
      errcode: 778,
    });
    await expectWorkerFailure(error, "disk I/O error (code=ERR_SQLITE_ERROR, errcode=778)");
  });

  it("bounds cause traversal while retaining codes from the last admitted node", async () => {
    let cause: unknown = { code: "HIDDEN_NINTH", errcode: 999 };
    for (let index = 7; index >= 0; index -= 1) {
      cause = Object.assign(new Error("staging failure", { cause }), {
        code: `E${index}`,
        errcode: index,
      });
    }
    await expectWorkerFailure(
      cause,
      "staging failure (code=E0, errcode=0, code=E1, errcode=1, code=E2, errcode=2, code=E3, errcode=3, code=E4, errcode=4, code=E5, errcode=5, code=E6, errcode=6, code=E7, errcode=7)",
    );
  });

  it.each(["", "lowercase", "EIO\n", "E IO", "ÉIO", "E".repeat(65), { secret: "hidden" }])(
    "omits unsafe code tokens: %j",
    async (code) => {
      await expectWorkerFailure(
        Object.assign(new Error("failure"), { code, errcode: 11 }),
        "failure (errcode=11)",
      );
    },
  );

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31, "778", 778n])(
    "omits errcode values outside Node's nonnegative signed integer contract: %s",
    async (errcode) => {
      await expectWorkerFailure(
        Object.assign(new Error("failure"), { code: "EIO", errcode }),
        "failure (code=EIO)",
      );
    },
  );

  it("retains the maximum allowed code token and SQLite integer", async () => {
    const code = "E".repeat(64);
    await expectWorkerFailure(
      Object.assign(new Error("failure"), { code, errcode: 2 ** 31 - 1 }),
      `failure (code=${code}, errcode=2147483647)`,
    );
  });
});
