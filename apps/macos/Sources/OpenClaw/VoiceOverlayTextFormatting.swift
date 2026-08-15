import AppKit

enum VoiceOverlayTextFormatting {
    static func delta(after committed: String, current: String) -> String {
        if current.hasPrefix(committed) {
            let start = current.index(current.startIndex, offsetBy: committed.count)
            return String(current[start...])
        }
        return current
    }

    static func makeAttributed(committed: String, volatile: String, isFinal: Bool) -> NSAttributedString {
        let full = NSMutableAttributedString()
        let committedAttr: [NSAttributedString.Key: Any] = [
            .foregroundColor: NSColor.labelColor,
            .font: NSFont.systemFont(ofSize: 13, weight: .regular),
        ]
        full.append(NSAttributedString(string: committed, attributes: committedAttr))
        let volatileColor: NSColor = isFinal ? .labelColor : NSColor.tertiaryLabelColor
        let volatileAttr: [NSAttributedString.Key: Any] = [
            .foregroundColor: volatileColor,
            .font: NSFont.systemFont(ofSize: 13, weight: .regular),
        ]
        full.append(NSAttributedString(string: volatile, attributes: volatileAttr))
        return full
    }
}
