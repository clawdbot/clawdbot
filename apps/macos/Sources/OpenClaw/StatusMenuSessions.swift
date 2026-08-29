import AppKit
import Foundation
import Observation
import SwiftUI

@MainActor
@Observable
final class StatusMenuSessions: NSObject {
    static let shared = StatusMenuSessions()

    private(set) var rows: [SessionRow] = []
    private(set) var errorText: String?
    private(set) var cachedSnapshot: SessionStoreSnapshot?

    @ObservationIgnored private var updatedAt: Date?
    @ObservationIgnored private var previewTasks: [Task<Void, Never>] = []
    @ObservationIgnored private let refreshInterval: TimeInterval = 12

    func refresh(force: Bool = false) async {
        if !force,
           let updatedAt,
           Date().timeIntervalSince(updatedAt) < self.refreshInterval
        {
            return
        }

        guard case .connected = ControlChannel.shared.state else {
            self.errorText = self.cachedSnapshot == nil
                ? nil
                : String(localized: "Gateway disconnected (showing cached)")
            self.updatedAt = Date()
            return
        }

        do {
            let snapshot = try await SessionLoader.loadSnapshot(limit: 32)
            self.cachedSnapshot = snapshot
            self.rows = snapshot.rows
            self.errorText = nil
            self.updatedAt = Date()
            self.prewarmPreviews(for: snapshot.rows)
        } catch {
            self.cachedSnapshot = nil
            self.rows = []
            self.errorText = self.compactError(error)
            self.updatedAt = Date()
        }
    }

    func configureSessionItem(_ item: NSMenuItem, row: SessionRow) {
        item.title = StatusMenuMetrics.fittedTitle(row.label)
        item.isEnabled = true
        StatusMenuRenderer.configureHostedView(item, rootView: StatusSessionCard(row: row), highlights: true)

        if let submenu = item.submenu {
            self.updateSessionSubmenu(submenu, row: row)
        } else {
            item.submenu = self.buildSessionSubmenu(for: row)
        }
    }

    func configureApprovalItem(_ item: NSMenuItem, request: ExecApprovalQueueItem) {
        item.title = String(localized: "Approval requested")
        item.isEnabled = true
        item.submenu = nil
        StatusMenuRenderer.configureHostedView(item, rootView: StatusApprovalCard(request: request))
    }

    func cancelPreviewTasks() {
        self.previewTasks.forEach { $0.cancel() }
        self.previewTasks.removeAll()
    }

    private func prewarmPreviews(for rows: [SessionRow]) {
        let keys = StatusMenuDescriptor.activeRows(
            from: rows,
            mainSessionKey: WorkActivityStore.shared.mainSessionKey)
            .prefix(6)
            .map(\.key)
        guard !keys.isEmpty else { return }
        self.previewTasks.append(Task {
            await SessionMenuPreviewLoader.prewarm(sessionKeys: keys, maxItems: 10)
        })
    }

    private func compactError(_ error: Error) -> String {
        if let loadError = error as? SessionLoadError {
            switch loadError {
            case .gatewayUnavailable:
                return String(localized: "No connection to gateway")
            case .decodeFailed:
                return String(localized: "Sessions unavailable")
            }
        }
        return String(localized: "Sessions unavailable")
    }
}

extension StatusMenuSessions {
    private func buildSessionSubmenu(for row: SessionRow) -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false
        menu.delegate = StatusMenuHighlightDelegate.shared
        StatusMenuAppearance.pin(menu)

        menu.addItem(self.makePreviewItem(
            sessionKey: row.key,
            title: String(localized: "Recent messages (last 10)"),
            maxLines: 3))

        let morePreview = NSMenuItem(title: String(localized: "More preview…"), action: nil, keyEquivalent: "")
        morePreview.submenu = self.buildPreviewSubmenu(sessionKey: row.key)
        menu.addItem(morePreview)

        if self.shouldRecommendCompaction(for: row) {
            menu.addItem(self.makeCompactItem(key: row.key, recommended: true))
        }

        menu.addItem(NSMenuItem.separator())

        let thinking = NSMenuItem(title: String(localized: "Thinking"), action: nil, keyEquivalent: "")
        thinking.identifier = NSUserInterfaceItemIdentifier("session.thinking")
        thinking.submenu = self.buildPreferenceMenu(
            key: row.key,
            levels: ["off", "minimal", "low", "medium", "high"],
            current: row.thinkingLevel,
            action: #selector(self.patchThinking(_:)))
        menu.addItem(thinking)

        let verbose = NSMenuItem(title: String(localized: "Verbose"), action: nil, keyEquivalent: "")
        verbose.identifier = NSUserInterfaceItemIdentifier("session.verbose")
        verbose.submenu = self.buildPreferenceMenu(
            key: row.key,
            levels: ["on", "off"],
            current: row.verboseLevel,
            action: #selector(self.patchVerbose(_:)))
        menu.addItem(verbose)

        self.updateDebugLogItem(in: menu, row: row)

        menu.addItem(NSMenuItem.separator())
        menu.addItem(self.makeActionItem(
            title: String(localized: "Reset Session"),
            action: #selector(self.resetSession(_:)),
            payload: row.key))
        menu.addItem(self.makeCompactItem(key: row.key, recommended: false))

        if row.key != WorkActivityStore.shared.mainSessionKey, row.key != "global" {
            menu.addItem(self.makeActionItem(
                title: String(localized: "Delete Session"),
                action: #selector(self.deleteSession(_:)),
                payload: row.key))
        }

        return menu
    }

    private func updateSessionSubmenu(_ menu: NSMenu, row: SessionRow) {
        let recommendedID = NSUserInterfaceItemIdentifier("session.compact-recommended")
        let recommendedIndex = menu.items.firstIndex { $0.identifier == recommendedID }
        if self.shouldRecommendCompaction(for: row), recommendedIndex == nil {
            menu.insertItem(self.makeCompactItem(key: row.key, recommended: true), at: min(2, menu.items.count))
        } else if !self.shouldRecommendCompaction(for: row), let recommendedIndex {
            menu.removeItem(at: recommendedIndex)
        }

        self.updatePreferenceMenu(
            menu.items.first { $0.identifier?.rawValue == "session.thinking" }?.submenu,
            current: row.thinkingLevel)
        self.updatePreferenceMenu(
            menu.items.first { $0.identifier?.rawValue == "session.verbose" }?.submenu,
            current: row.verboseLevel)
        self.updateDebugLogItem(in: menu, row: row)
    }

    private func updateDebugLogItem(in menu: NSMenu, row: SessionRow) {
        let logID = NSUserInterfaceItemIdentifier("session.open-log")
        let separatorID = NSUserInterfaceItemIdentifier("session.open-log-separator")
        let existing = menu.items.first { $0.identifier == logID }

        guard AppStateStore.shared.debugPaneEnabled,
              AppStateStore.shared.connectionMode == .local,
              let sessionId = row.sessionId,
              !sessionId.isEmpty
        else {
            if let existing {
                menu.removeItem(existing)
            }
            if let separator = menu.items.first(where: { $0.identifier == separatorID }) {
                menu.removeItem(separator)
            }
            return
        }

        let payload = ["sessionId": sessionId, "storePath": self.cachedSnapshot?.storePath ?? ""]
        if let existing {
            existing.representedObject = payload
            return
        }

        guard let verboseIndex = menu.items.firstIndex(where: { $0.identifier?.rawValue == "session.verbose" })
        else { return }
        let separator = NSMenuItem.separator()
        separator.identifier = separatorID
        menu.insertItem(separator, at: verboseIndex + 1)

        let openLog = self.makeActionItem(
            title: String(localized: "Open Session Log"),
            action: #selector(self.openSessionLog(_:)),
            payload: payload)
        openLog.identifier = logID
        menu.insertItem(openLog, at: verboseIndex + 2)
    }

    private func shouldRecommendCompaction(for row: SessionRow) -> Bool {
        guard let percentUsed = row.tokens.percentUsed else { return false }
        return Double(percentUsed) / 100 >= ContextRingView.compactThreshold
    }

    private func makeCompactItem(key: String, recommended: Bool) -> NSMenuItem {
        let title = recommended
            ? String(localized: "Compact Session Log (recommended)")
            : String(localized: "Compact Session Log")
        let item = self.makeActionItem(title: title, action: #selector(self.compactSession(_:)), payload: key)
        if recommended {
            item.identifier = NSUserInterfaceItemIdentifier("session.compact-recommended")
            item.image = NSImage(systemSymbolName: "exclamationmark.circle", accessibilityDescription: nil)
        }
        return item
    }

    private func buildPreferenceMenu(key: String, levels: [String], current: String?, action: Selector) -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false
        menu.showsStateColumn = true
        menu.delegate = StatusMenuHighlightDelegate.shared
        StatusMenuAppearance.pin(menu)
        let selected = levels.contains(current ?? "") ? current ?? "off" : "off"

        for level in levels {
            let item = self.makeActionItem(
                title: self.preferenceTitle(for: level),
                action: action,
                payload: ["key": key, "value": level])
            item.state = selected == level ? .on : .off
            menu.addItem(item)
        }

        return menu
    }

    private func preferenceTitle(for level: String) -> String {
        switch level {
        case "off": String(localized: "Off")
        case "on": String(localized: "On")
        case "minimal": String(localized: "Minimal")
        case "low": String(localized: "Low")
        case "medium": String(localized: "Medium")
        case "high": String(localized: "High")
        default: level.capitalized
        }
    }

    private func updatePreferenceMenu(_ menu: NSMenu?, current: String?) {
        guard let menu else { return }
        let selected = menu.items.contains {
            ($0.representedObject as? [String: String])?["value"] == current
        } ? current : "off"

        for item in menu.items {
            let value = (item.representedObject as? [String: String])?["value"]
            item.state = value == selected ? .on : .off
        }
    }

    private func buildPreviewSubmenu(sessionKey: String) -> NSMenu {
        let menu = NSMenu()
        menu.delegate = StatusMenuHighlightDelegate.shared
        StatusMenuAppearance.pin(menu)
        menu.addItem(self.makePreviewItem(
            sessionKey: sessionKey,
            title: String(localized: "Recent messages (expanded)"),
            maxLines: 8))
        return menu
    }

    private func makePreviewItem(sessionKey: String, title: String, maxLines: Int) -> NSMenuItem {
        let item = NSMenuItem()
        item.isEnabled = false
        StatusMenuRenderer.configureHostedView(
            item,
            rootView: SessionMenuPreviewView(
                maxLines: maxLines,
                title: title,
                items: [],
                status: .loading)
                .environment(\.isEnabled, true))

        self.previewTasks.append(Task { [weak item] in
            let snapshot = await SessionMenuPreviewLoader.load(sessionKey: sessionKey, maxItems: 10)
            guard !Task.isCancelled, let item else { return }
            StatusMenuRenderer.configureHostedView(
                item,
                rootView: SessionMenuPreviewView(
                    maxLines: maxLines,
                    title: title,
                    items: snapshot.items,
                    status: snapshot.status)
                    .environment(\.isEnabled, true))
        })

        return item
    }

    private func makeActionItem(title: String, action: Selector, payload: Any) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self
        item.representedObject = payload
        item.isEnabled = true
        return item
    }
}

extension StatusMenuSessions {
    @objc private func patchThinking(_ sender: NSMenuItem) {
        guard let payload = sender.representedObject as? [String: String],
              let key = payload["key"],
              let value = payload["value"]
        else { return }

        Task {
            do {
                try await SessionActions.patchSession(key: key, thinking: .some(value))
                await self.refresh(force: true)
            } catch {
                SessionActions.presentError(title: String(localized: "Update thinking failed"), error: error)
            }
        }
    }

    @objc private func patchVerbose(_ sender: NSMenuItem) {
        guard let payload = sender.representedObject as? [String: String],
              let key = payload["key"],
              let value = payload["value"]
        else { return }

        Task {
            do {
                try await SessionActions.patchSession(key: key, verbose: .some(value))
                await self.refresh(force: true)
            } catch {
                SessionActions.presentError(title: String(localized: "Update verbose failed"), error: error)
            }
        }
    }

    @objc private func openSessionLog(_ sender: NSMenuItem) {
        guard let payload = sender.representedObject as? [String: String],
              let sessionId = payload["sessionId"]
        else { return }
        SessionActions.openSessionLogInCode(sessionId: sessionId, storePath: payload["storePath"])
    }

    @objc private func resetSession(_ sender: NSMenuItem) {
        guard let key = sender.representedObject as? String else { return }
        Task {
            guard SessionActions.confirmDestructiveAction(
                title: String(localized: "Reset session?"),
                message: String(localized: "Starts a new session ID for “\(key)”."),
                action: String(localized: "Reset"))
            else { return }

            do {
                try await SessionActions.resetSession(key: key)
                await self.refresh(force: true)
            } catch {
                SessionActions.presentError(title: String(localized: "Reset failed"), error: error)
            }
        }
    }

    @objc private func compactSession(_ sender: NSMenuItem) {
        guard let key = sender.representedObject as? String else { return }
        Task {
            guard SessionActions.confirmDestructiveAction(
                title: String(localized: "Compact session log?"),
                message: String(localized: "Keeps the last 400 lines and archives the old file."),
                action: String(localized: "Compact"))
            else { return }

            do {
                try await SessionActions.compactSession(key: key, maxLines: 400)
                await self.refresh(force: true)
            } catch {
                SessionActions.presentError(title: String(localized: "Compact failed"), error: error)
            }
        }
    }

    @objc private func deleteSession(_ sender: NSMenuItem) {
        guard let key = sender.representedObject as? String,
              key != WorkActivityStore.shared.mainSessionKey,
              key != "global"
        else { return }

        Task {
            guard SessionActions.confirmDestructiveAction(
                title: String(localized: "Delete session?"),
                message: String(localized: "Deletes the “\(key)” entry and archives its transcript."),
                action: String(localized: "Delete"))
            else { return }

            do {
                try await SessionActions.deleteSession(key: key)
                await self.refresh(force: true)
            } catch {
                SessionActions.presentError(title: String(localized: "Delete failed"), error: error)
            }
        }
    }
}
