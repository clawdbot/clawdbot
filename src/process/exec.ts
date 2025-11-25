import { execFile, spawn } from "node:child_process";

import { danger, isVerbose } from "../globals.js";

export async function runExec(
	command: string,
	args: string[],
	timeoutMs = 10_000,
): Promise<{ stdout: string; stderr: string }> {
	// Simple promise-wrapped execFile with optional verbosity logging.
	try {
		const { stdout, stderr } = await execFile(command, args, {
			timeout: timeoutMs,
		});
		if (isVerbose()) {
			if (stdout.trim()) console.log(stdout.trim());
			if (stderr.trim()) console.error(stderr.trim());
		}
		return { stdout, stderr };
	} catch (err) {
		if (isVerbose()) {
			console.error(danger(`Command failed: ${command} ${args.join(" ")}`));
		}
		throw err;
	}
}

export type SpawnResult = {
	stdout: string;
	stderr: string;
	code: number | null;
	signal: NodeJS.Signals | null;
	killed: boolean;
};

export async function runCommandWithTimeout(
	argv: string[],
	timeoutMs: number,
): Promise<SpawnResult> {
	// Spawn with inherited stdin (TTY) so tools like `claude` don't hang.
	return await new Promise((resolve, reject) => {
		const child = spawn(argv[0], argv.slice(1), {
			stdio: ["inherit", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
		}, timeoutMs);

		child.stdout?.on("data", (d) => {
			stdout += d.toString();
		});
		child.stderr?.on("data", (d) => {
			stderr += d.toString();
		});
		child.on("error", (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(err);
		});
		child.on("close", (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ stdout, stderr, code, signal, killed: child.killed });
		});
	});
}
