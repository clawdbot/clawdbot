import type { Mock } from "vitest";
import { vi } from "vitest";

export const terminalNoteMock: Mock<(...args: unknown[]) => unknown> = vi.fn();

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note: (...args: unknown[]) => terminalNoteMock(...args),
}));

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
