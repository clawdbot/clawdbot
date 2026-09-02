import path from "node:path";
import { expect, it } from "vitest";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";

it.skipIf(process.platform === "win32").each(["fetch-only", "checkout"])(
  "keeps checkout HTTP authentication transient and scoped (%s)",
  async (mode) => {
    let stdout = "";
    let stderr = "";
    const code = await runManagedCommand({
      bin: "python3",
      args: [
        "-I",
        "-S",
        "test/scripts/fixtures/ci-checkout-auth.py",
        path.resolve(".github/actions/git-owner/owner.py"),
        mode,
      ],
      stdio: ["ignore", "pipe", "pipe"],
      timeoutMs: 30_000,
      timeoutKillGraceMs: 12_000,
      requireProcessTreeExit: true,
      onReady(child) {
        child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
        child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
      },
    });
    expect(code, stderr).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      mode,
      fetchAuthenticated: true,
      missingBlobBeforeCheckout: true,
      lazyCheckoutSucceeded: mode === "checkout",
      credentialPersisted: false,
    });
  },
  50_000,
);
