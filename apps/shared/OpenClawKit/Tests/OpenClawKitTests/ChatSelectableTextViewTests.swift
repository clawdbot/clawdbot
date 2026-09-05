#if os(iOS)
import Testing
@testable import OpenClawChatUI

@MainActor
struct ChatSelectableTextViewTests {
    @Test func `configured view supports native text selection`() {
        let textView = ChatSelectableTextViewFactory.makeConfiguredTextView()

        #expect(textView.isSelectable)
        #expect(!textView.isEditable)
        #expect(textView.adjustsFontForContentSizeCategory)
        #expect(textView.font?.fontName == OpenClawChatTypography.bodyUIFont.fontName)
        #expect(textView.accessibilityIdentifier == "chat-selectable-text")
        #expect(textView.isScrollEnabled)
    }
}
#endif
