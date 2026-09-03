import Darwin
import Foundation
import Testing
@testable import OpenClaw

struct CuaDriverStderrRelayTests {
    @Test(arguments: [false, true])
    @MainActor
    func `releasing the exited process wrapper preserves its pending stderr drain`(retainWriter: Bool) async throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try Data(("gate\n" + String(repeating: "x", count: 4090) + "\n").utf8).write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        let probe = CuaDriverStderrProbe()
        let entered = DispatchSemaphore(value: 0)
        let release = DispatchSemaphore(value: 0)
        let exited = DispatchSemaphore(value: 0)
        let notified = DispatchSemaphore(value: 0)
        let relay = CuaDriverStderrRelay { event in
            probe.append(event)
            if event == .error("gate") {
                entered.signal()
                release.wait()
            }
        }
        let descriptor = retainWriter ? fcntl(relay.pipe.fileHandleForWriting.fileDescriptor, F_DUPFD_CLOEXEC, 0) : -1
        try #require(!retainWriter || descriptor >= 0)
        let writer = retainWriter ? FileHandle(fileDescriptor: descriptor, closeOnDealloc: true) : nil
        let input = Pipe()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = [
            "-c", "/bin/cat \"$1\" >&2; IFS= read -r release; printf 'final driver diagnostic' >&2",
            "driver", file.path,
        ]
        process.standardInput = input
        process.standardOutput = FileHandle.nullDevice
        process.standardError = relay.pipe
        process.terminationHandler = { _ in
            exited.signal()
            Task {
                await relay.finishReading()
                notified.signal()
            }
        }
        try relay.startReading()
        try process.run()
        var wrapper: FoundationCuaDriverProcess? = FoundationCuaDriverProcess(
            process: process, livenessPipe: input)
        weak var weakWrapper = wrapper
        defer {
            release.signal()
            relay.stop()
            try? writer?.close()
            if process.isRunning { process.terminate() }
            process.waitUntilExit()
        }
        try #require(await Self.waitForSignal(entered))
        try input.fileHandleForWriting.write(contentsOf: Data("exit\n".utf8))
        try #require(await Self.waitForSignal(exited))

        #expect(!process.isRunning)
        #expect(await !Self.waitForSignal(notified, timeout: 0))
        wrapper = nil
        #expect(weakWrapper == nil)
        release.signal()
        #expect(await Self.waitForSignal(notified))
        #expect(process.terminationStatus == 0)
        #expect(probe.events.contains(.error("final driver diagnostic")))
    }

    private static func waitForSignal(_ signal: DispatchSemaphore, timeout: TimeInterval = 2) async -> Bool {
        await withCheckedContinuation { continuation in
            DispatchQueue.global().async {
                continuation.resume(returning: signal.wait(timeout: .now() + timeout) == .success)
            }
        }
    }

    @Test func `stderr relay filters the banner and forwards diagnostics before the driver exits`() throws {
        let probe = CuaDriverStderrProbe()
        let relay = CuaDriverStderrRelay { probe.append($0) }
        try relay.startReading()
        relay.reportManagedMode()
        relay.reportManagedMode()

        let input = Pipe()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = [
            "-c",
            """
            printf '%s\\n' 'DANGER: Cua Driver is running in unrestricted mode. Runtime approval prompts are disabled.' \\
                'driver diagnostic' >&2
            IFS= read -r response
            """,
        ]
        process.standardInput = input
        process.standardOutput = FileHandle.nullDevice
        process.standardError = relay.pipe
        try process.run()
        defer {
            try? input.fileHandleForWriting.close()
            if process.isRunning {
                process.terminate()
            }
            process.waitUntilExit()
            relay.stop()
        }

        let delivered = probe.diagnostic.wait(timeout: .now() + 2) == .success
        #expect(process.isRunning)
        #expect(delivered, "The driver is waiting for input; stderr must not wait for its exit")
        try input.fileHandleForWriting.write(contentsOf: Data("done\n".utf8))
        process.waitUntilExit()
        relay.stop()

        #expect(process.terminationStatus == 0)
        #expect(probe.events == [
            .notice(CuaDriverStderrRelay.managedModeNotice),
            .error("driver diagnostic"),
        ])
    }

    @Test(arguments: [false, true])
    func `truncated UTF8 retains the remaining driver diagnostic`(endsWithNewline: Bool) async throws {
        let diagnostic = "final driver diagnostic"
        let ending = diagnostic + (endsWithNewline ? "\n" : "")
        // The 32 KiB byte tail starts at the continuation byte of é.
        let payload = Data((String(repeating: "p", count: 4095) + "é" +
                String(repeating: "x", count: 32767 - ending.utf8.count) + ending).utf8)
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try payload.write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        let probe = CuaDriverStderrProbe()
        let relay = CuaDriverStderrRelay { probe.append($0) }
        try relay.startReading()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", "exec /bin/cat \"$1\" >&2", "driver", file.path]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = relay.pipe
        try process.run()
        defer {
            relay.stop()
            if process.isRunning { process.terminate() }
            process.waitUntilExit()
        }

        process.waitUntilExit()
        await relay.finishReading()

        #expect(process.terminationStatus == 0)
        #expect(probe.events.count == 1)
        guard case let .error(message) = probe.events.first else {
            Issue.record("Truncating a UTF-8 scalar discarded the entire diagnostic")
            return
        }
        #expect(message.hasSuffix(diagnostic))
        #expect(message.count <= 32768)
    }

    @Test func `EOF forwards an unterminated diagnostic once`() throws {
        let probe = CuaDriverStderrProbe()
        let relay = CuaDriverStderrRelay { probe.append($0) }
        defer { relay.stop() }
        try relay.startReading()
        #expect(relay.pipe.fileHandleForWriting.disableSIGPIPE())
        try relay.pipe.fileHandleForWriting.write(contentsOf: Data("final diagnostic".utf8))
        try relay.pipe.fileHandleForWriting.close()

        #expect(probe.diagnostic.wait(timeout: .now() + 2) == .success)
        relay.stop()
        relay.stop()
        #expect(probe.events == [.error("final diagnostic")])
    }

    @Test(arguments: [false, true])
    func `natural exit drains queued stderr but explicit stop cancels it`(naturalExit: Bool) throws {
        let firstChunk = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try Data(("gate\n" + String(repeating: "x", count: 4090) + "\n").utf8).write(to: firstChunk)
        defer { try? FileManager.default.removeItem(at: firstChunk) }
        let probe = CuaDriverStderrProbe()
        let entered = DispatchSemaphore(value: 0)
        let release = DispatchSemaphore(value: 0)
        let exited = DispatchSemaphore(value: 0)
        let notified = DispatchSemaphore(value: 0)
        let closed = DispatchSemaphore(value: 0)
        let relay = CuaDriverStderrRelay { event in
            probe.append(event)
            if event == .error("gate") {
                entered.signal()
                release.wait()
            }
        }
        let descriptor = fcntl(relay.pipe.fileHandleForWriting.fileDescriptor, F_DUPFD_CLOEXEC, 0)
        try #require(descriptor >= 0)
        let retainedWriter = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        let input = Pipe()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = [
            "-c", "/bin/cat \"$1\" >&2; IFS= read -r release; printf 'final driver diagnostic' >&2",
            "worker", firstChunk.path,
        ]
        process.standardInput = input
        process.standardOutput = FileHandle.nullDevice
        process.standardError = relay.pipe
        process.terminationHandler = { _ in
            exited.signal()
            Task {
                if naturalExit {
                    await relay.finishReading()
                } else {
                    relay.stop()
                }
                notified.signal()
            }
        }
        try relay.startReading()
        try process.run()
        defer {
            release.signal()
            relay.stop()
            try? retainedWriter.close()
            try? input.fileHandleForWriting.close()
            if process.isRunning {
                process.terminate()
            }
            process.waitUntilExit()
        }
        try #require(entered.wait(timeout: .now() + 2) == .success)
        try input.fileHandleForWriting.write(contentsOf: Data("exit\n".utf8))
        process.waitUntilExit()
        try #require(exited.wait(timeout: .now() + 2) == .success)
        if naturalExit {
            #expect(notified.wait(timeout: .now()) == .timedOut)
        } else {
            #expect(notified.wait(timeout: .now() + 2) == .success)
        }
        release.signal()
        if naturalExit {
            #expect(notified.wait(timeout: .now() + 2) == .success)
        }
        Task { await relay.finishReading()
            closed.signal()
        }
        #expect(closed.wait(timeout: .now() + 2) == .success)
        #expect(process.terminationStatus == 0)
        #expect(probe.events.contains(.error("final driver diagnostic")) == naturalExit)
    }
}

private final class CuaDriverStderrProbe: @unchecked Sendable {
    let diagnostic = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var captured: [CuaDriverStderrEvent] = []

    var events: [CuaDriverStderrEvent] {
        self.lock.withLock { self.captured }
    }

    func append(_ event: CuaDriverStderrEvent) {
        self.lock.withLock { self.captured.append(event) }
        if case .error = event {
            self.diagnostic.signal()
        }
    }
}
