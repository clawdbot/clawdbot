import AppKit
import Foundation
import Observation
import SwiftUI

/// Unified store + window owner for node/device pairing approvals. Both
/// prompters feed request cards here; one floating panel renders them all so
/// simultaneous requests never stack serial dialogs.
@MainActor
@Observable
final class PairingApprovalCenter {
    static let shared = PairingApprovalCenter()

    enum Kind: String, CaseIterable {
        case node
        case device
    }

    enum Decision {
        case approve
        case reject
    }

    struct Card: Identifiable, Equatable {
        let kind: Kind
        let requestId: String
        /// nodeId or deviceId.
        let subjectId: String
        let displayName: String?
        let platform: String?
        let deviceFamily: String?
        let modelIdentifier: String?
        let version: String?
        let coreVersion: String?
        let remoteIp: String?
        /// Device pairing operator role.
        let role: String?
        /// Device pairing operator scopes.
        let scopes: [String]
        /// Node capability surface.
        let caps: [String]
        /// Node command surface (drives the elevated-access warning).
        let commands: [String]
        let isRepair: Bool
        /// nil until a fresh gateway list confirms pairing history; a positive
        /// trust claim must never come from a stale snapshot.
        let previouslyPaired: Bool?
        let requestedAt: Date

        var id: String {
            self.requestId
        }
    }

    typealias DecisionHandler = @MainActor (Card, Decision) async -> Void

    private(set) var cards: [Card] = []
    private(set) var decisionsInFlight: Set<String> = []
    private var handlersByKind: [Kind: DecisionHandler] = [:]
    private var panel: PairingApprovalPanelController?
    /// Request ids visible when the user chose "Not Now"; the panel reopens
    /// automatically only when a request they have not seen yet arrives.
    private var snoozedRequestIds: Set<String> = []
    /// Request ids the visible panel has already presented. Periodic queue
    /// syncs must not re-activate the app; only genuinely new requests may.
    private var presentedRequestIds: Set<String> = []

    func register(kind: Kind, handler: @escaping DecisionHandler) {
        self.handlersByKind[kind] = handler
    }

    func unregister(kind: Kind) {
        self.handlersByKind[kind] = nil
        self.sync(kind: kind, cards: [])
    }

    /// Replace all cards of one kind (the owning prompter's queue is the
    /// source of truth). Cards stay ordered oldest-first across both kinds.
    func sync(kind: Kind, cards: [Card]) {
        var others = self.cards.filter { $0.kind != kind }
        #if DEBUG
        others += self.cards.filter { $0.kind == kind && self.demoRequestIds.contains($0.requestId) }
        #endif
        // requestId tiebreaker: Swift sort is not stable and equal timestamps
        // would let cards swap positions between syncs.
        self.cards = (others + cards).sorted {
            ($0.requestedAt, $0.requestId) < ($1.requestedAt, $1.requestId)
        }
        self.snoozedRequestIds.formIntersection(self.cards.map(\.id))
        self.updatePanel()
    }

    func decide(_ card: Card, _ decision: Decision) {
        #if DEBUG
        if self.demoRequestIds.contains(card.requestId) {
            self.demoRequestIds.remove(card.requestId)
            self.cards.removeAll { $0.requestId == card.requestId }
            self.updatePanel()
            return
        }
        #endif
        guard let handler = self.handlersByKind[card.kind] else { return }
        guard self.decisionsInFlight.insert(card.requestId).inserted else { return }
        Task { @MainActor in
            await handler(card, decision)
            self.decisionsInFlight.remove(card.requestId)
        }
    }

    /// "Not Now": hide the panel without resolving anything. Requests stay
    /// pending on the gateway (TTL applies) and in the menu-bar count.
    func snooze() {
        self.snoozedRequestIds = Set(self.cards.map(\.id))
        self.panel?.hide()
    }

    func showPanel() {
        guard !self.cards.isEmpty else { return }
        self.snoozedRequestIds.removeAll()
        self.presentedRequestIds.formUnion(self.cards.map(\.id))
        self.ensurePanel().show()
    }

    static func shouldAutoPresent(cardIds: [String], snoozedIds: Set<String>) -> Bool {
        !cardIds.isEmpty && !cardIds.allSatisfy { snoozedIds.contains($0) }
    }

    private func updatePanel() {
        if self.cards.isEmpty {
            self.snoozedRequestIds.removeAll()
            self.presentedRequestIds.removeAll()
            self.panel?.hide()
            return
        }
        let cardIds = self.cards.map(\.id)
        guard Self.shouldAutoPresent(cardIds: cardIds, snoozedIds: self.snoozedRequestIds) else {
            self.panel?.refreshLayout()
            return
        }
        // Activate (app focus + key panel) only for the first presentation or
        // a request not shown yet; periodic reconcile syncs merely refresh, so
        // the panel cannot steal focus every poll interval.
        let hasNewRequests = !cardIds.allSatisfy { self.presentedRequestIds.contains($0) }
        self.snoozedRequestIds.removeAll()
        self.presentedRequestIds.formUnion(cardIds)
        let panel = self.ensurePanel()
        if panel.isPanelVisible, !hasNewRequests {
            panel.refreshLayout()
        } else {
            panel.show()
        }
    }

    private func ensurePanel() -> PairingApprovalPanelController {
        if let panel = self.panel {
            return panel
        }
        let panel = PairingApprovalPanelController(center: self)
        self.panel = panel
        return panel
    }

    #if DEBUG
    /// Demo/screenshot hook: decisions on injected cards resolve locally
    /// instead of routing to a prompter.
    private var demoRequestIds: Set<String> = []

    func injectDemoCards(_ cards: [Card]) {
        self.demoRequestIds.formUnion(cards.map(\.id))
        let existing = Set(self.cards.map(\.id))
        self.cards += cards.filter { !existing.contains($0.id) }
        self.snoozedRequestIds.removeAll()
        self.updatePanel()
    }
    #endif
}

/// Borderless floating panel hosting the SwiftUI approval UI. Replaces the
/// old invisible-host-window + NSAlert sheet machinery.
@MainActor
final class PairingApprovalPanelController {
    private final class KeyablePanel: NSPanel {
        override var canBecomeKey: Bool {
            true
        }

        override var canBecomeMain: Bool {
            true
        }
    }

    private let center: PairingApprovalCenter
    private var panel: NSPanel?
    private var hostingView: NSHostingView<PairingApprovalPanelView>?

    static let panelWidth: CGFloat = 460

    init(center: PairingApprovalCenter) {
        self.center = center
    }

    var isPanelVisible: Bool {
        self.panel?.isVisible == true
    }

    func show() {
        let panel = self.ensurePanel()
        self.applyFittingFrame()
        // Approval is a security decision: bring the app forward like the old
        // NSAlert flow so the prompt is keyboard-actionable immediately.
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        // No initial focus ring (matches NSAlert); Tab starts keyboard
        // navigation, Return approves a single request, Esc snoozes.
        panel.makeFirstResponder(nil)
        self.refreshLayout()
    }

    func hide() {
        self.panel?.orderOut(nil)
    }

    func refreshLayout() {
        // The root view stays installed (it observes the center directly);
        // replacing it would reset SwiftUI focus. Re-measure on the next tick
        // so pending Observation-driven updates are applied first.
        DispatchQueue.main.async { [weak self] in
            self?.applyFittingFrame()
        }
    }

    private func applyFittingFrame() {
        guard let panel = self.panel, let host = self.hostingView else { return }
        var size = host.fittingSize
        // Request metadata sizes the panel; clamp to the screen so the action
        // buttons stay reachable (the card list scrolls inside).
        if let screen = panel.screen ?? NSScreen.main {
            size.height = min(size.height, screen.visibleFrame.height * 0.85)
        }
        let target = self.centeredFrame(for: size)
        if target == panel.frame {
            return
        }
        if panel.isVisible {
            panel.setFrame(target, display: true, animate: true)
        } else {
            panel.setFrame(target, display: true)
        }
    }

    private func ensurePanel() -> NSPanel {
        if let panel = self.panel {
            return panel
        }
        let panel = KeyablePanel(
            contentRect: NSRect(x: 0, y: 0, width: Self.panelWidth, height: 200),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        // The SwiftUI view draws its own rounded shadow; the window shadow
        // would trace the square window frame and look like a border.
        panel.hasShadow = false
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.hidesOnDeactivate = false
        panel.isMovableByWindowBackground = true
        panel.isReleasedWhenClosed = false
        panel.becomesKeyOnlyIfNeeded = false

        let host = NSHostingView(rootView: PairingApprovalPanelView(center: self.center))
        panel.contentView = host
        self.hostingView = host
        self.panel = panel
        return panel
    }

    private func centeredFrame(for size: NSSize) -> NSRect {
        guard let screen = self.panel?.screen ?? NSScreen.main else {
            return NSRect(origin: .zero, size: size)
        }
        let bounds = screen.visibleFrame
        // Slightly above center, where system alerts sit.
        let x = bounds.midX - size.width / 2
        let y = bounds.midY - size.height / 2 + bounds.height * 0.08
        return NSRect(x: x, y: y, width: size.width, height: size.height)
    }
}
