// Provides temporary filesystem cases for security audit tests.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Small async temp directory factory for security tests with numbered cases. */
export class AsyncTempCaseFactory {
  private caseId = 0;
  private fixtureRoot = "";

  constructor(private readonly prefix: string) {}

  async setup() {
    this.fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), this.prefix));
  }

  async cleanup() {
    if (!this.fixtureRoot) {
      return;
    }
    await fs.rm(this.fixtureRoot, { recursive: true, force: true }).catch(() => undefined);
  }

  async makeTmpDir(label: string) {
    const dir = path.join(this.fixtureRoot, `case-${this.caseId++}-${label}`);
    // Labels are test-authored and become path suffixes; callers keep them
    // simple so failure output remains readable.
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }
}
