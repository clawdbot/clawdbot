import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("keeps the PID identity source closure loadable by native Node without a workspace resolver", () => {
  const source = new URL("../shared/pid-alive.ts", import.meta.url).href;
  const stdout = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const module = await import(${JSON.stringify(source)}); console.log(typeof module.getFileLockProcessStartTime);`,
    ],
    { env: {}, encoding: "utf8", timeout: 5000 },
  );
  expect(stdout.trim()).toBe("function");
});
