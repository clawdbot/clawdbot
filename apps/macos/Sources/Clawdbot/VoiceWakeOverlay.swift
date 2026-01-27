import AppKit
import Observation
import SwiftUI

/// Lightweight, borderless panel that shows the current voice wake transcript near the menu bar.
@MainActor
@Observable
final class VoiceWakeOverlayController {
    static let shared = VoiceWakeOverlayController()

    let logger = Logger(subsystem: "com.clawdbot", category: "voicewake.overlay")
    let enableUI: Bool

    /// Keep the voice wake overlay above any other Moltbot windows, but below the system’s pop-up menus.
    /// (Menu bar menus typically live at `.popUpMenu`.)
    static let preferredWindowLevel = NSWindow.Level(rawValue: NSWindow.Level.popUpMenu.rawValue - 4)

    enum Source: String { case wakeWord, pushToTalk }

    var model = Model()
    var isVisible: Bool { self.model.isVisible }

    struct Model {
        var text: String = ""
        var isFinal: Bool = false
        var isVisible: Bool = false
        var forwardEnabled: Bool = false
        var isSending: Bool = false
        var attributed: NSAttributedString = .init(string: "")
        var isOverflowing: Bool = false
        var isEditing: Bool = false
        var level: Double = 0 // normalized 0...1 speech level for UI
    }

    var window: NSPanel?
    var hostingView: NSHostingView<VoiceWakeOverlayView>?
    var autoSendTask: Task<Void, Never>?
    var autoSendToken: UUID?
    var activeToken: UUID?
    var activeSource: Source?
    var lastLevelUpdate: TimeInterval = 0

    let width: CGFloat = 360
    let padding: CGFloat = 10
    let buttonWidth: CGFloat = 36
    let spacing: CGFloat = 8
    let verticalPadding: CGFloat = 8
    let maxHeight: CGFloat = 400
    let minHeight: CGFloat = 48
    let closeOverflow: CGFloat = 10
    let levelUpdateInterval: TimeInterval = 1.0 / 12.0

    enum DismissReason { case explicit, empty }
    enum SendOutcome { case sent, empty }
    enum GuardOutcome { case accept, dropMismatch, dropNoActive }

    init(enableUI: Bool = true) {
        self.enableUI = enableUI
    }
}
