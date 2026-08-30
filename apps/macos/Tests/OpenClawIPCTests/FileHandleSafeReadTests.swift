import Foundation
import Testing
@testable import OpenClaw

struct FileHandleSafeReadTests {
    @Test func `read to end safely returns empty for closed handle`() {
        let pipe = Pipe()
        let handle = pipe.fileHandleForReading
        try? handle.close()

        let data = handle.readToEndSafely()
        #expect(data.isEmpty)
    }

    @Test func `read safely up to count returns empty for closed handle`() {
        let pipe = Pipe()
        let handle = pipe.fileHandleForReading
        try? handle.close()

        let data = handle.readSafely(upToCount: 16)
        #expect(data.isEmpty)
    }

    @Test func `read to end safely reads pipe contents`() {
        let pipe = Pipe()
        let writeHandle = pipe.fileHandleForWriting
        writeHandle.write(Data("hello".utf8))
        try? writeHandle.close()

        let data = pipe.fileHandleForReading.readToEndSafely()
        #expect(String(data: data, encoding: .utf8) == "hello")
    }

    @Test func `read safely up to count reads incrementally`() {
        let pipe = Pipe()
        let writeHandle = pipe.fileHandleForWriting
        writeHandle.write(Data("hello world".utf8))
        try? writeHandle.close()

        let readHandle = pipe.fileHandleForReading
        let first = readHandle.readSafely(upToCount: 5)
        let second = readHandle.readSafely(upToCount: 32)

        #expect(String(data: first, encoding: .utf8) == "hello")
        #expect(String(data: second, encoding: .utf8) == " world")
    }
}
