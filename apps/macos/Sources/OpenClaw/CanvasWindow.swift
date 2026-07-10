import AppKit

let canvasWindowLogger = Logger(subsystem: "ai.openclaw", category: "Canvas")

enum CanvasLayout {
    static let panelSize = NSSize(width: 520, height: 680)
    static let windowSize = NSSize(width: 1120, height: 840)
    static let anchorPadding: CGFloat = 8
    static let defaultPadding: CGFloat = 10
    static let minPanelSize = NSSize(width: 360, height: 360)
}

final class CanvasPanel: NSPanel {
    override var canBecomeKey: Bool {
        true
    }

    override var canBecomeMain: Bool {
        true
    }
}

enum CanvasPresentation {
    case window
    case panel(anchorProvider: () -> NSRect?)

    var isPanel: Bool {
        if case .panel = self { return true }
        return false
    }
}
