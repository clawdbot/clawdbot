import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// One owner for chat copy actions on both platforms.
enum ChatPasteboard {
    @MainActor
    static func copy(_ text: String) {
        #if os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        #else
        UIPasteboard.general.string = text
        #endif
    }
}

/// Compact icon button that copies `text` and briefly confirms with a checkmark.
@MainActor
struct ChatCopyButton: View {
    let text: String
    let label: LocalizedStringKey
    var revealed = true

    // Shared control hit target for inline block controls.
    #if os(macOS)
    static let controlSize: CGFloat = 28
    #else
    static let controlSize: CGFloat = 44
    #endif

    @State private var copiedAt: Date?
    #if os(macOS)
    @FocusState private var isFocused: Bool
    #endif

    var body: some View {
        Button {
            ChatPasteboard.copy(self.text)
            self.copiedAt = .now
        } label: {
            Image(systemName: self.copiedAt == nil ? "doc.on.doc" : "checkmark")
                .frame(width: Self.controlSize, height: Self.controlSize)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(self.label)
        .contentTransition(.symbolEffect(.replace))
        .task(id: self.copiedAt) {
            guard let copiedAt = self.copiedAt else { return }
            // A repeat tap changes the id and cancels this task; the newer task owns the reset,
            // so bail on cancellation and only clear the confirmation this task scheduled.
            guard await (try? Task.sleep(for: .seconds(1.5))) != nil, self.copiedAt == copiedAt else { return }
            self.copiedAt = nil
        }
        // macOS reveals inline controls on hover or keyboard focus.
        // iOS has no hover, so the controls stay visible.
        #if os(macOS)
        .help(self.label)
        .focused(self.$isFocused)
        .opacity(self.revealed || self.isFocused || self.copiedAt != nil ? 1 : 0)
        #endif
    }
}
