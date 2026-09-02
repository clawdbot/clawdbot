import Foundation

/// How the Watch composer collects text. WatchKit only opens the system dictation
/// screen directly when the suggestion list is nil and emoji are disallowed; any
/// list (even empty) or emoji mode routes through the keyboard/Scribble picker.
enum WatchComposerInputKind: Equatable {
    case dictation
    case typed

    var suggestions: [String]? {
        switch self {
        case .dictation: nil
        case .typed: []
        }
    }

    var allowsEmoji: Bool {
        self == .typed
    }

    var speaksReply: Bool {
        self == .dictation
    }
}

/// A just-submitted message shown in Chat until the iPhone snapshot echoes it back,
/// so a dictated turn has a visible outcome before the relay round-trip completes.
struct WatchPendingTranscript: Equatable {
    private(set) var text: String?

    mutating func begin(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        self.text = trimmed
    }

    mutating func clear() {
        self.text = nil
    }

    /// Drops the pending copy once the synced timeline carries a user item with the same trimmed text.
    @discardableResult
    mutating func resolve(items: [WatchChatItem]) -> Bool {
        guard let text = self.text,
              items.contains(where: { item in
                  item.role.lowercased() == "user"
                      && item.text.trimmingCharacters(in: .whitespacesAndNewlines) == text
              })
        else {
            return false
        }
        self.text = nil
        return true
    }
}
