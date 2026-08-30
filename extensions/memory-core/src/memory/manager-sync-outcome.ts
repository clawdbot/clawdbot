// Memory Core owns admission-ordered sync outcome reporting.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { redactSensitiveText } from "openclaw/plugin-sdk/security-runtime";

export class MemorySyncOutcomeLedger {
  private nextGeneration = 0;
  private latestSuccessfulGeneration = 0;
  private latestFailure?: { generation: number; reason: string };
  private activeGeneration?: number;

  async track(operation: () => Promise<string | undefined | void>, active = false): Promise<void> {
    const generation = ++this.nextGeneration;
    if (active) {
      this.activeGeneration = generation;
    }
    try {
      const incompleteReason = await operation();
      if (incompleteReason) {
        this.recordFailure(generation, incompleteReason);
      } else if (this.latestFailure?.generation !== generation) {
        this.latestSuccessfulGeneration = Math.max(this.latestSuccessfulGeneration, generation);
      }
    } catch (error) {
      this.recordFailure(generation, error);
      throw error;
    } finally {
      if (this.activeGeneration === generation) {
        this.activeGeneration = undefined;
      }
    }
  }

  recordActiveFailure(error: unknown): void {
    if (this.activeGeneration !== undefined) {
      this.recordFailure(this.activeGeneration, error);
    }
  }

  get lastError(): string | undefined {
    return this.latestFailure && this.latestFailure.generation > this.latestSuccessfulGeneration
      ? this.latestFailure.reason
      : undefined;
  }

  private recordFailure(generation: number, error: unknown): void {
    if (generation <= (this.latestFailure?.generation ?? 0)) {
      return;
    }
    this.latestFailure = {
      generation,
      reason: redactSensitiveText(formatErrorMessage(error), { mode: "tools" }),
    };
  }
}
