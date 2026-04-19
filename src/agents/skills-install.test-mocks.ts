import { Mock, vi } from "vitest";

export const runCommandWithTimeoutMock: Mock<(...args: unknown[]) => unknown> = vi.fn();
export const scanDirectoryWithSummaryMock: Mock<(...args: unknown[]) => unknown> = vi.fn();
export const fetchWithSsrFGuardMock: Mock<(...args: unknown[]) => unknown> = vi.fn();
export const hasBinaryMock: Mock<(bin: string) => boolean> = vi.fn();
