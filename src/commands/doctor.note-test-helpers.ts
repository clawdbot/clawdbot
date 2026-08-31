/** Test helpers for loading doctor command with terminal note output mocked. */
import type { Mock } from "vitest";
import { vi } from "vitest";

export const terminalNoteMock: Mock<(...args: unknown[]) => unknown> = vi.fn();

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note: (...args: unknown[]) => terminalNoteMock(...args),
}));

/** Loads doctorCommand after resetting modules and applying the terminal note mock. */
export async function loadDoctorCommandForTest(params?: { unmockModules?: string[] }) {
  vi.resetModules();
  vi.doMock("../../packages/terminal-core/src/note.js", () => ({
    note: (...args: unknown[]) => terminalNoteMock(...args),
  }));
  for (const modulePath of params?.unmockModules ?? []) {
    vi.doUnmock(modulePath);
  }
  const { doctorCommand } = await import("./doctor.js");
  terminalNoteMock.mockClear();
  return doctorCommand;
}
