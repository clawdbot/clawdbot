import { describe, expect, it, vi } from "vitest";

import { isYes, setVerbose, setYes } from "../globals.js";

vi.mock("node:readline/promises", () => {
	const question = vi.fn<[], Promise<string>>();
	const close = vi.fn();
	const createInterface = vi.fn(() => ({ question, close }));
	return { default: { createInterface } };
});

type ReadlineMock = {
	default: {
		createInterface: () => {
			question: ReturnType<typeof vi.fn<[], Promise<string>>>;
			close: ReturnType<typeof vi.fn>;
		};
	};
};

const { promptYesNo } = await import("./prompt.js");
const readline = (await import("node:readline/promises")) as ReadlineMock;

describe("promptYesNo", () => {
	it("returns true when global --yes is set", async () => {
		setYes(true);
		setVerbose(false);
		const result = await promptYesNo("Continue?");
		expect(result).toBe(true);
		expect(isYes()).toBe(true);
	});

	it("asks the question and respects default", async () => {
		setYes(false);
		setVerbose(false);
		const { question: questionMock } = readline.default.createInterface();
		questionMock.mockResolvedValueOnce("");
		const resultDefaultYes = await promptYesNo("Continue?", true);
		expect(resultDefaultYes).toBe(true);

		questionMock.mockResolvedValueOnce("n");
		const resultNo = await promptYesNo("Continue?", true);
		expect(resultNo).toBe(false);

		questionMock.mockResolvedValueOnce("y");
		const resultYes = await promptYesNo("Continue?", false);
		expect(resultYes).toBe(true);
	});
});
