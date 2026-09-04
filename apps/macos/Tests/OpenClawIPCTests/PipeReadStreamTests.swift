import Darwin
import Foundation
import Testing
@testable import OpenClaw

struct PipeReadStreamTests {
    @Test func `cancelled finish still joins reader cleanup`() throws {
        let pipe = Pipe()
        let probe = PipeReadProbe()
        let entered = DispatchSemaphore(value: 0)
        let release = DispatchSemaphore(value: 0)
        let started = DispatchSemaphore(value: 0)
        let joined = DispatchSemaphore(value: 0)
        let reader = try PipeReadStream(
            handle: pipe.fileHandleForReading,
            onData: { data in
                probe.append(data)
                entered.signal()
                release.wait()
            },
            onClose: { probe.finish() })
        defer {
            release.signal()
            reader.close()
            try? pipe.fileHandleForWriting.close()
        }
        try pipe.fileHandleForReading.close()
        try pipe.fileHandleForWriting.write(contentsOf: Data("first".utf8))
        try #require(entered.wait(timeout: .now() + 2) == .success)
        let closing = Task {
            started.signal()
            await reader.finish()
            joined.signal()
        }
        closing.cancel()
        try #require(started.wait(timeout: .now() + 2) == .success)
        #expect(joined.wait(timeout: .now() + 0.1) == .timedOut)
        release.signal()
        #expect(joined.wait(timeout: .now() + 2) == .success)
        #expect(probe.finishCount == 1)
    }

    @Test func `reader drains large child output in bounded chunks before closing`() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let payload = Data((0..<200_003).map { UInt8(truncatingIfNeeded: $0) })
        try payload.write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        let pipe = Pipe()
        let probe = PipeReadProbe()
        let reader = try PipeReadStream(
            handle: pipe.fileHandleForReading,
            maximumChunkBytes: 4096,
            onData: { probe.append($0) },
            onClose: { probe.finish() })
        let child = Process()
        child.executableURL = URL(fileURLWithPath: "/bin/cat")
        child.arguments = [file.path]
        child.standardOutput = pipe
        child.standardError = FileHandle.nullDevice
        try child.run()
        defer {
            reader.close()
            try? pipe.fileHandleForReading.close()
            if child.isRunning {
                child.terminate()
            }
            child.waitUntilExit()
        }

        let closed = probe.finished.wait(timeout: .now() + 3) == .success
        #expect(closed)
        if !closed {
            child.terminate()
        }
        child.waitUntilExit()
        reader.close()

        #expect(child.terminationStatus == 0)
        #expect(probe.contents == payload)
        #expect(probe.chunkSizes.count > 1)
        #expect(probe.chunkSizes.allSatisfy { $0 > 0 && $0 <= 4096 })
        #expect(probe.finishCount == 1)
    }

    @Test(arguments: [false, true])
    func `reader survives original handle closure and releases its own descriptor`(dropOwner: Bool) throws {
        let pipe = Pipe()
        let probe = PipeReadProbe()
        var reader: PipeReadStream? = try PipeReadStream(
            handle: pipe.fileHandleForReading,
            onData: { probe.append($0) },
            onClose: { probe.finish() })
        defer {
            reader?.close()
            try? pipe.fileHandleForWriting.close()
        }
        #expect(pipe.fileHandleForWriting.disableSIGPIPE())
        try pipe.fileHandleForReading.close()
        try pipe.fileHandleForWriting.write(contentsOf: Data("still streaming".utf8))
        #expect(probe.received.wait(timeout: .now() + 2) == .success)
        #expect(probe.contents == Data("still streaming".utf8))

        let deadline = DispatchTime.now() + 2
        if dropOwner {
            reader = nil
        } else {
            reader?.close()
            reader?.close()
        }
        let closed = probe.finished.wait(timeout: deadline) == .success
        #expect(closed)

        var byte: UInt8 = 0
        var written: Int
        var writeError: Int32
        // Concurrent child startup briefly inherits even CLOEXEC descriptors.
        // EPIPE observes all process references, so share the cleanup deadline.
        repeat {
            written = Darwin.write(pipe.fileHandleForWriting.fileDescriptor, &byte, 1)
            writeError = errno
            if written == -1 { break }
            Thread.sleep(forTimeInterval: 0.001)
        } while DispatchTime.now() < deadline
        #expect(written == -1)
        #expect(writeError == EPIPE)
        #expect(probe.finishCount == 1)
    }
}

private final class PipeReadProbe: @unchecked Sendable {
    let received = DispatchSemaphore(value: 0)
    let finished = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var data = Data()
    private var sizes: [Int] = []
    private var closes = 0

    var contents: Data {
        self.lock.withLock { self.data }
    }

    var chunkSizes: [Int] {
        self.lock.withLock { self.sizes }
    }

    var finishCount: Int {
        self.lock.withLock { self.closes }
    }

    func append(_ chunk: Data) {
        self.lock.withLock {
            self.data.append(chunk)
            self.sizes.append(chunk.count)
        }
        self.received.signal()
    }

    func finish() {
        self.lock.withLock { self.closes += 1 }
        self.finished.signal()
    }
}
