// Skill install test mocks centralize mocked lifecycle dependencies for tests.
import { vi } from "vitest";
import type { Mock } from "vitest";

/** Shared Vitest mocks for skill install tests that mock heavy dependencies. */
export const runCommandWithTimeoutMock: Mock<(...args: unknown[]) => unknown> = vi.fn();
export const scanDirectoryWithSummaryMock: Mock<(...args: unknown[]) => unknown> = vi.fn();
export const fetchWithSsrFGuardMock: Mock<(...args: unknown[]) => unknown> = vi.fn();
export const hasBinaryMock: Mock<(bin: string) => boolean> = vi.fn();
