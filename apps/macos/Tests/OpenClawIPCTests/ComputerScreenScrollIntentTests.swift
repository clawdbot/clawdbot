import Foundation
import Testing

struct ComputerScreenScrollIntentTests {
    @Test func `global screen scroll explicitly authorizes foreground input`() throws {
        let packageRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let source = try String(
            contentsOf: packageRoot.appendingPathComponent("Sources/OpenClaw/ComputerScreenActionExecutor.swift"),
            encoding: .utf8)

        // Peekaboo's ScrollRequest defaults to background and requires a snapshot/target there.
        // Guard the actual caller's explicit consent without adding a production injection hook.
        // This source contract does not prove native wheel delivery.
        let callPattern = try NSRegularExpression(
            pattern: #"(?s)self\.automation\.scroll\(\s*ScrollRequest\((.*?)\)\s*\)"#)
        let calls = callPattern.matches(in: source, range: NSRange(source.startIndex..., in: source))
        try #require(calls.count == 1, "Expected the screen-owned ScrollRequest call")
        let argumentsRange = try #require(Range(calls[0].range(at: 1), in: source))
        let arguments = String(source[argumentsRange])
        #expect(
            arguments.range(of: #"(?:^|,)\s*foreground\s*:\s*true\s*(?:,|$)"#, options: .regularExpression) != nil,
            "SCREEN_SCROLL_FOREGROUND_REQUIRED: global-screen ScrollRequest must explicitly pass foreground: true")
    }
}
