#if os(iOS)
import Testing
import UIKit
@testable import OpenClawChatUI

@MainActor
struct ChatPasteboardTests {
    @Test func `copy writes the exact text to the general pasteboard`() {
        // Only read back this process's own write: reading content another app placed on the
        // pasteboard triggers the iOS paste prompt and blocks the test.
        ChatPasteboard.copy("let greeting = \"copied\"\n")

        #expect(UIPasteboard.general.string == "let greeting = \"copied\"\n")
    }
}
#endif
