import { describe, expect, it, vi } from "vitest";

import { waitForever } from "./wait.js";

describe("waitForever", () => {
	it("creates an unref'ed interval and returns a pending promise", () => {
		const setIntervalSpy = vi.spyOn(global, "setInterval");
		const promise = waitForever();
		expect(setIntervalSpy).toHaveBeenCalledWith(
			expect.any(Function),
			1_000_000,
		);
		expect(promise).toBeInstanceOf(Promise);
		setIntervalSpy.mockRestore();
	});
});
