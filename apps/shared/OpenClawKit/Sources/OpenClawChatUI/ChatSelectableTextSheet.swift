#if os(iOS)
import SwiftUI
import UIKit

@MainActor
struct ChatSelectableTextSheet: View {
    let text: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ChatSelectableTextView(text: self.text)
                .navigationTitle("Select Text")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button {
                            self.dismiss()
                        } label: {
                            Text("Close").font(OpenClawChatTypography.body)
                        }
                    }
                }
        }
    }
}

@MainActor
private struct ChatSelectableTextView: UIViewRepresentable {
    let text: String

    func makeUIView(context: Context) -> UITextView {
        let textView = ChatSelectableTextViewFactory.makeConfiguredTextView()
        textView.text = self.text
        return textView
    }

    func updateUIView(_ textView: UITextView, context: Context) {
        if textView.text != self.text {
            textView.text = self.text
        }
    }
}

enum ChatSelectableTextViewFactory {
    /// Internal for @testable coverage of the native selection defaults.
    @MainActor
    static func makeConfiguredTextView() -> UITextView {
        let textView = UITextView()
        textView.isEditable = false
        textView.isSelectable = true
        textView.isScrollEnabled = true
        textView.alwaysBounceVertical = true
        textView.backgroundColor = .clear
        textView.textColor = .label
        textView.font = OpenClawChatTypography.bodyUIFont
        textView.adjustsFontForContentSizeCategory = true
        textView.textContainerInset = UIEdgeInsets(top: 16, left: 20, bottom: 16, right: 20)
        textView.accessibilityIdentifier = "chat-selectable-text"
        return textView
    }
}
#endif
