import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { createIMessageRpcClient } from "./client.js";

const spawnMock = vi.fn();

vi.mock("node:child_process", () => ({
    spawn: (...args: unknown[]) => spawnMock(...args),
}));

describe("IMessageRpcClient", () => {
    it("detects permission denied errors and logs friendly message", async () => {
        const stdout = new PassThrough();
        const child = {
            stdout,
            stderr: new EventEmitter(),
            on: vi.fn(),
            stdin: { write: vi.fn(), end: vi.fn() },
            kill: vi.fn(),
        };
        spawnMock.mockReturnValue(child);

        const runtimeErrorMock = vi.fn();
        const client = await createIMessageRpcClient({
            runtime: { error: runtimeErrorMock } as any,
        });

        // Simulate imsg permission error output
        const errorLine =
            'permissionDenied(path: "/Users/shelton/Library/Messages/chat.db", underlying: authorization denied (code: 23)): Unexpected token \'p\', "permission"... is not valid JSON';
        stdout.emit("data", Buffer.from(errorLine + "\n"));

        // Wait a tick for the readline interface to process
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(runtimeErrorMock).toHaveBeenCalledWith(
            expect.stringContaining(
                "imsg permission denied: Please grant Full Disk Access",
            ),
        );

        // Verify it didn't log the generic parse error
        expect(runtimeErrorMock).not.toHaveBeenCalledWith(
            expect.stringContaining("imsg rpc: failed to parse"),
        );
    });

    it("logs generic parse errors for other garbage output", async () => {
        const stdout = new PassThrough();
        const child = {
            stdout,
            stderr: new EventEmitter(),
            on: vi.fn(),
            stdin: { write: vi.fn(), end: vi.fn() },
            kill: vi.fn(),
        };
        spawnMock.mockReturnValue(child);

        const runtimeErrorMock = vi.fn();
        const client = await createIMessageRpcClient({
            runtime: { error: runtimeErrorMock } as any,
        });

        // Simulate random garbage output
        stdout.emit("data", Buffer.from("some random garbage\n"));

        // Wait a tick
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(runtimeErrorMock).toHaveBeenCalledWith(
            expect.stringContaining("imsg rpc: failed to parse"),
        );
    });
});
