import { describe, expect, it, vi } from "vitest";

import { setVerbose } from "./globals.js";
import { logDebug, logError, logInfo, logSuccess, logWarn } from "./logger.js";
import type { RuntimeEnv } from "./runtime.js";

describe("logger helpers", () => {
	it("formats messages through runtime log/error", () => {
		const log = vi.fn();
		const error = vi.fn();
		const runtime: RuntimeEnv = { log, error, exit: vi.fn() };

		logInfo("info", runtime);
		logWarn("warn", runtime);
		logSuccess("ok", runtime);
		logError("bad", runtime);

		expect(log).toHaveBeenCalledTimes(3);
		expect(error).toHaveBeenCalledTimes(1);
	});

	it("only logs debug when verbose is enabled", () => {
		const logVerbose = vi.spyOn(console, "log");
		setVerbose(false);
		logDebug("quiet");
		expect(logVerbose).not.toHaveBeenCalled();

		setVerbose(true);
		logVerbose.mockClear();
		logDebug("loud");
		expect(logVerbose).toHaveBeenCalled();
		logVerbose.mockRestore();
	});
});
