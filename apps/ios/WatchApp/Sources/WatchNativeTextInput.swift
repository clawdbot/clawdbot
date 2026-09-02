import Foundation
import WatchKit

enum WatchNativeTextInput {
    /// WatchKit opens the system dictation screen directly only for a nil
    /// suggestion list in `.plain` mode; any list or emoji mode shows the
    /// keyboard/Scribble/dictation picker first.
    @MainActor
    static func present(_ kind: WatchComposerInputKind, onSubmit: @escaping (String) -> Void) {
        WKApplication.shared().visibleInterfaceController?.presentTextInputController(
            withSuggestions: kind.suggestions,
            allowedInputMode: kind.allowsEmoji ? .allowEmoji : .plain)
        { results in
            guard let text = results?.compactMap(stringValue).first?
                .trimmingCharacters(in: .whitespacesAndNewlines),
                !text.isEmpty
            else {
                return
            }
            onSubmit(text)
        }
    }

    private static func stringValue(_ result: Any) -> String? {
        if let string = result as? String {
            return string
        }
        if let attributed = result as? NSAttributedString {
            return attributed.string
        }
        return nil
    }
}
