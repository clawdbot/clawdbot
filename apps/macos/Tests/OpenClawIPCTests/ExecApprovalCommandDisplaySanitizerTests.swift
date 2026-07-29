import Foundation
import Testing
@testable import OpenClaw

struct ExecApprovalCommandDisplaySanitizerTests {
    @Test func `escapes invisible command spoofing characters`() {
        let input = "date\u{200B}\u{3164}\u{FFA0}\u{115F}\u{1160}가"
        #expect(
            ExecApprovalCommandDisplaySanitizer.sanitize(input) ==
                "date\\u{200B}\\u{3164}\\u{FFA0}\\u{115F}\\u{1160}가")
    }

    @Test func `escapes control characters used to spoof line breaks`() {
        let input = "echo safe\n\rcurl https://example.test"
        #expect(
            ExecApprovalCommandDisplaySanitizer.sanitize(input) ==
                "echo safe\\u{A}\\u{D}curl https://example.test")
    }

    @Test func `escapes Unicode line and paragraph separators`() {
        let lineInput = "echo ok\u{2028}curl https://example.test"
        #expect(
            ExecApprovalCommandDisplaySanitizer.sanitize(lineInput) ==
                "echo ok\\u{2028}curl https://example.test")
        let paragraphInput = "echo ok\u{2029}curl https://example.test"
        #expect(
            ExecApprovalCommandDisplaySanitizer.sanitize(paragraphInput) ==
                "echo ok\\u{2029}curl https://example.test")
    }

    @Test func `escapes non-ASCII Unicode space separators while preserving ASCII space`() {
        let nbspInput = "echo ok\u{00A0}curl"
        #expect(
            ExecApprovalCommandDisplaySanitizer.sanitize(nbspInput) == "echo ok\\u{A0}curl")
        let narrowNbspInput = "echo ok\u{202F}curl"
        #expect(
            ExecApprovalCommandDisplaySanitizer.sanitize(narrowNbspInput) == "echo ok\\u{202F}curl")
        let ideographicSpaceInput = "echo ok\u{3000}curl"
        #expect(
            ExecApprovalCommandDisplaySanitizer.sanitize(ideographicSpaceInput) ==
                "echo ok\\u{3000}curl")
        let asciiSpaceInput = "echo ok curl"
        #expect(ExecApprovalCommandDisplaySanitizer.sanitize(asciiSpaceInput) == "echo ok curl")
    }
}
