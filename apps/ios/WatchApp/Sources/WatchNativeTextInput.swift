import Foundation
import WatchKit

enum WatchNativeTextInput {
    @MainActor
    static func present(
        suggestions: [String],
        onSubmit: @escaping (String) -> Void)
    {
        WKApplication.shared().visibleInterfaceController?.presentTextInputController(
            withSuggestions: suggestions,
            allowedInputMode: .allowEmoji)
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
