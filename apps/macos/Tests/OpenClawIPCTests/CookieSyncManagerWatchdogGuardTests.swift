import Foundation
import Testing

struct CookieSyncManagerWatchdogGuardTests {
    @Test func `startup watchdog runs on the main actor queue`() throws {
        let testFile = URL(fileURLWithPath: #filePath)
        let packageRoot = testFile
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let managerFile = packageRoot
            .appendingPathComponent("Sources/OpenClaw/CookieSyncManager.swift")
        let source = try String(contentsOf: managerFile, encoding: .utf8)
        let start = try #require(source.range(of: "    private func installStartupWatchdog"))
        let following = source[start.upperBound...]
        let end = try #require(following.range(of: "\n    private func "))
        let watchdog = source[start.lowerBound..<end.lowerBound]

        #expect(watchdog.contains("DispatchSource.makeTimerSource(queue: .main)"))
    }
}
