import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => {
	const spawn = vi.fn((_cmd: string, _args: string[]) => {
		const proc = new EventEmitter() as EventEmitter & {
			kill: ReturnType<typeof vi.fn>;
		};
		queueMicrotask(() => {
			proc.emit("exit", 0);
		});
		proc.kill = vi.fn();
		return proc;
	});
	return { spawn };
});

const { spawnRelayTmux } = await import("./relay_tmux.js");
const { spawn } = await import("node:child_process");

describe("spawnRelayTmux", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("kills old session, starts new one, and attaches", async () => {
		const session = await spawnRelayTmux("echo hi", true, true);
		expect(session).toBe("warelay-relay");
		const spawnMock = spawn as unknown as vi.Mock;
		expect(spawnMock.mock.calls.length).toBe(3);
		const calls = spawnMock.mock.calls as Array<[string, string[], unknown]>;
		expect(calls[0][0]).toBe("tmux"); // kill-session
		expect(calls[1][2]?.cmd ?? "").not.toBeUndefined(); // new session
		expect(calls[2][1][0]).toBe("attach-session");
	});

	it("can skip attach", async () => {
		await spawnRelayTmux("echo hi", false, true);
		const spawnMock = spawn as unknown as vi.Mock;
		const hasAttach = spawnMock.mock.calls.some(
			(c) =>
				Array.isArray(c[1]) && (c[1] as string[]).includes("attach-session"),
		);
		expect(hasAttach).toBe(false);
	});
});
