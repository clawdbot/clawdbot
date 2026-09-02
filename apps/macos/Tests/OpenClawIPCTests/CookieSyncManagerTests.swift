import Foundation
import Testing
@testable import OpenClaw

#if canImport(Darwin)
@MainActor
struct CookieSyncManagerTests {
    @Test func `stdout read handler survives being invoked off the main actor`() async throws {
        let manager = CookieSyncManager()
        let generation = UUID()
        manager.processGeneration = generation

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        manager.installReadSources(stdoutPipe: stdoutPipe, stderrPipe: stderrPipe, generation: generation)

        try stdoutPipe.fileHandleForWriting.write(contentsOf: Data("hello\n".utf8))
        try stdoutPipe.fileHandleForWriting.close()
        try stderrPipe.fileHandleForWriting.close()

        for _ in 0..<100 where manager.lastSummary != "hello" {
            try await Task.sleep(for: .milliseconds(20))
        }
        #expect(manager.lastSummary == "hello")
    }
}
#endif
