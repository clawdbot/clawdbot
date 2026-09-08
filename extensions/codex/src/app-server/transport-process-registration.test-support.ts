import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";

export class RegistrationTestChildProcess extends ChildProcess {
  override pid!: number;
  override stdin!: PassThrough;
  override stdout!: PassThrough;
  override stderr!: PassThrough;
  override stdio!: [PassThrough, PassThrough, PassThrough, null, null];

  constructor(pid: number) {
    super();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdio: RegistrationTestChildProcess["stdio"] = [stdin, stdout, stderr, null, null];
    // Bun inherits getter-only stdio properties. Define the fixture's own mutable
    // fields instead of assigning through those accessors.
    for (const [key, value] of Object.entries({ pid, stdin, stdout, stderr, stdio })) {
      Object.defineProperty(this, key, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  }
}
