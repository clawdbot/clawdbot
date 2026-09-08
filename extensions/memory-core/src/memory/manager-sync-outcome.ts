// Memory Core owns process-local sync outcome reporting.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { redactSensitiveText } from "openclaw/plugin-sdk/security-runtime";

export class MemorySyncOutcomeLedger {
  private failureRevision = 0;
  private latestFailure?: { revision: number; reason: string };
  private active = false;

  async track(operation: () => Promise<string | undefined | void>, active = false): Promise<void> {
    const failureAtStart = this.latestFailure?.revision;
    if (active) {
      this.active = true;
    }
    try {
      const incompleteReason = await operation();
      if (incompleteReason) {
        this.recordFailure(incompleteReason);
      } else if (failureAtStart !== undefined && this.latestFailure?.revision === failureAtStart) {
        this.latestFailure = undefined;
      }
    } catch (error) {
      this.recordFailure(error);
      throw error;
    } finally {
      if (active) {
        this.active = false;
      }
    }
  }

  recordActiveFailure(error: unknown): void {
    if (this.active) {
      this.recordFailure(error);
    }
  }

  get lastError(): string | undefined {
    return this.latestFailure?.reason;
  }

  private recordFailure(error: unknown): void {
    this.latestFailure = {
      revision: ++this.failureRevision,
      reason: redactSensitiveText(formatErrorMessage(error), { mode: "tools" }),
    };
  }
}
