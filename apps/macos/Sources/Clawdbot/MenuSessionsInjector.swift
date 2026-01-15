import AppKit
import SwiftUI

@MainActor
final class MenuSessionsInjector: NSObject, NSMenuDelegate {
    static let shared = MenuSessionsInjector()

    private let tag = 9_415_557
    private let nodesTag = 9_415_558
    private let fallbackWidth: CGFloat = 320
    private let activeWindowSeconds: TimeInterval = 24 * 60 * 60

    private weak var originalDelegate: NSMenuDelegate?
    private weak var statusItem: NSStatusItem?
    private var loadTask: Task<Void, Never>?
    private var nodesLoadTask: Task<Void, Never>?
    private var isMenuOpen = false
    private var lastKnownMenuWidth: CGFloat?
    private var menuOpenWidth: CGFloat?

    private var cachedSnapshot: SessionStoreSnapshot?
    private var cachedErrorText: String?
    private var cacheUpdatedAt: Date?
    private let refreshIntervalSeconds: TimeInterval = 12
    private var cachedUsageSummary: GatewayUsageSummary?
    private var cachedUsageErrorText: String?
    private var usageCacheUpdatedAt: Date?
    private let usageRefreshIntervalSeconds: TimeInterval = 30
    private let nodesStore = NodesStore.shared
    #if DEBUG
    private var testControlChannelConnected: Bool?
    #endif

    func install(into statusItem: NSStatusItem) {
        self.statusItem = statusItem
        guard let menu = statusItem.menu else { return }

        // Preserve SwiftUI's internal NSMenuDelegate, otherwise it may stop populating menu items.
        if menu.delegate !== self {
            self.originalDelegate = menu.delegate
            menu.delegate = self
        }

        if self.loadTask == nil {
            self.loadTask = Task { await self.refreshCache(force: true) }
        }

        self.nodesStore.start()
    }

    func menuWillOpen(_ menu: NSMenu) {
        self.originalDelegate?.menuWillOpen?(menu)
        self.isMenuOpen = true
        self.menuOpenWidth = self.currentMenuWidth(for: menu)

        self.inject(into: menu)
        self.injectNodes(into: menu)

        // Refresh in background for the next open; keep width stable while open.
        self.loadTask?.cancel()
        let forceRefresh = self.cachedSnapshot == nil || self.cachedErrorText != nil
        self.loadTask = Task { [weak self] in
            guard let self else { return }
            await self.refreshCache(force: forceRefresh)
            await self.refreshUsageCache(force: forceRefresh)
            await MainActor.run {
                guard self.isMenuOpen else { return }
                self.inject(into: menu)
                self.injectNodes(into: menu)
            }
        }

        self.nodesLoadTask?.cancel()
        self.nodesLoadTask = Task { [weak self] in
            guard let self else { return }
            await self.nodesStore.refresh()
            await MainActor.run {
                guard self.isMenuOpen else { return }
                self.injectNodes(into: menu)
            }
        }
    }

    func menuDidClose(_ menu: NSMenu) {
        self.originalDelegate?.menuDidClose?(menu)
        self.isMenuOpen = false
        self.menuOpenWidth = nil
        self.loadTask?.cancel()
        self.nodesLoadTask?.cancel()
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        self.originalDelegate?.menuNeedsUpdate?(menu)
    }

    func confinementRect(for menu: NSMenu, on screen: NSScreen?) -> NSRect {
        if let rect = self.originalDelegate?.confinementRect?(for: menu, on: screen) {
            return rect
        }
        return NSRect.zero
    }
}

extension MenuSessionsInjector {
    // MARK: - Injection
    private var mainSessionKey: String { WorkActivityStore.shared.mainSessionKey }

    private func inject(into menu: NSMenu) {
        // Remove any previous injected items.
        for item in menu.items where item.tag == self.tag {
            menu.removeItem(item)
        }

        guard let insertIndex = self.findInsertIndex(in: menu) else { return }
        let width = self.initialWidth(for: menu)
        let isConnected = self.isControlChannelConnected
        let channelState = ControlChannel.shared.state

        var cursor = insertIndex
        var headerView: NSView?

        if let snapshot = self.cachedSnapshot {
            let now = Date()
            let mainKey = self.mainSessionKey
            let rows = snapshot.rows.filter { row in
                if row.key == "main", mainKey != "main" { return false }
                if row.key == mainKey { return true }
                guard let updatedAt = row.updatedAt else { return false }
                return now.timeIntervalSince(updatedAt) <= self.activeWindowSeconds
            }.sorted { lhs, rhs in
                if lhs.key == mainKey { return true }
                if rhs.key == mainKey { return false }
                return (lhs.updatedAt ?? .distantPast) > (rhs.updatedAt ?? .distantPast)
            }

            let headerItem = NSMenuItem()
            headerItem.tag = self.tag
            headerItem.isEnabled = false
            let hosted = self.makeHostedView(
                rootView: AnyView(MenuSessionsHeaderView(
                                    count: rows.count,
                                    statusText: isConnected ? nil : self.controlChannelStatusText(for: channelState))),
                width: width,
                highlighted: false)
            headerItem.view = hosted
            headerView = hosted
            menu.insertItem(headerItem, at: cursor)
            cursor += 1

            if rows.isEmpty {
                menu.insertItem(
                    self.makeMessageItem(text: "No active sessions", symbolName: "minus", width: width),
                    at: cursor)
                cursor += 1
            } else {
                for row in rows {
                    let item = NSMenuItem()
                    item.tag = self.tag
                    item.isEnabled = true
                    item.submenu = self.buildSubmenu(for: row, storePath: snapshot.storePath)
                    item.view = self.makeHostedView(
                        rootView: AnyView(SessionMenuLabelView(row: row, width: width)),
                        width: width,
                        highlighted: true)
                    menu.insertItem(item, at: cursor)
                    cursor += 1
                }
            }
        } else {
            let headerItem = NSMenuItem()
            headerItem.tag = self.tag
            headerItem.isEnabled = false
            let statusText = isConnected
                ? (self.cachedErrorText ?? "Loading sessions…")
                : self.controlChannelStatusText(for: channelState)
            let hosted = self.makeHostedView(
                rootView: AnyView(MenuSessionsHeaderView(
                                    count: 0,
                                    statusText: statusText)),
                width: width,
                highlighted: false)
            headerItem.view = hosted
            headerView = hosted
            menu.insertItem(headerItem, at: cursor)
            cursor += 1

            if !isConnected {
                menu.insertItem(
                    self.makeMessageItem(
                        text: "Connect the gateway to see sessions",
                        symbolName: "bolt.slash",
                        width: width),
                    at: cursor)
                cursor += 1
            }
        }

        cursor = self.insertUsageSection(into: menu, at: cursor, width: width)

        DispatchQueue.main.async { [weak self, weak headerView] in
            guard let self, let headerView else { return }
            self.captureMenuWidthIfAvailable(from: headerView)
        }
    }

    private func injectNodes(into menu: NSMenu) {
        for item in menu.items where item.tag == self.nodesTag {
            menu.removeItem(item)
        }

        guard let insertIndex = self.findNodesInsertIndex(in: menu) else { return }
        let width = self.initialWidth(for: menu)
        var cursor = insertIndex

        let entries = self.sortedNodeEntries()
        let topSeparator = NSMenuItem.separator()
        topSeparator.tag = self.nodesTag
        menu.insertItem(topSeparator, at: cursor)
        cursor += 1

        if let gatewayEntry = self.gatewayEntry() {
            let gatewayItem = self.makeNodeItem(entry: gatewayEntry, width: width)
            menu.insertItem(gatewayItem, at: cursor)
            cursor += 1
        }

        if case .connecting = ControlChannel.shared.state {
            menu.insertItem(
                self.makeMessageItem(text: "Connecting…", symbolName: "circle.dashed", width: width),
                at: cursor)
            cursor += 1
            return
        }

        guard self.isControlChannelConnected else { return }

        if let error = self.nodesStore.lastError?.nonEmpty {
            menu.insertItem(
                self.makeMessageItem(
                    text: "Error: \(error)",
                    symbolName: "exclamationmark.triangle",
                    width: width),
                at: cursor)
            cursor += 1
        } else if let status = self.nodesStore.statusMessage?.nonEmpty {
            menu.insertItem(
                self.makeMessageItem(text: status, symbolName: "info.circle", width: width),
                at: cursor)
            cursor += 1
        }

        if entries.isEmpty {
            let title = self.nodesStore.isLoading ? "Loading devices..." : "No devices yet"
            menu.insertItem(
                self.makeMessageItem(text: title, symbolName: "circle.dashed", width: width),
                at: cursor)
            cursor += 1
        } else {
            for entry in entries.prefix(8) {
                let item = self.makeNodeItem(entry: entry, width: width)
                menu.insertItem(item, at: cursor)
                cursor += 1
            }

            if entries.count > 8 {
                let moreItem = NSMenuItem()
                moreItem.tag = self.nodesTag
                moreItem.title = "More Devices..."
                moreItem.image = NSImage(systemSymbolName: "ellipsis.circle", accessibilityDescription: nil)
                let overflow = Array(entries.dropFirst(8))
                moreItem.submenu = self.buildNodesOverflowMenu(entries: overflow, width: width)
                menu.insertItem(moreItem, at: cursor)
                cursor += 1
            }
        }

        _ = cursor
    }

    private func insertUsageSection(into menu: NSMenu, at cursor: Int, width: CGFloat) -> Int {
        let rows = self.usageRows
        let errorText = self.cachedUsageErrorText

        if rows.isEmpty, errorText == nil {
            return cursor
        }

        var cursor = cursor

        if cursor > 0, !menu.items[cursor - 1].isSeparatorItem {
            let separator = NSMenuItem.separator()
            separator.tag = self.tag
            menu.insertItem(separator, at: cursor)
            cursor += 1
        }

        let headerItem = NSMenuItem()
        headerItem.tag = self.tag
        headerItem.isEnabled = false
        headerItem.view = self.makeHostedView(
            rootView: AnyView(MenuUsageHeaderView(
                                count: rows.count)),
            width: width,
            highlighted: false)
        menu.insertItem(headerItem, at: cursor)
        cursor += 1

        if let errorText = errorText?.nonEmpty, !rows.isEmpty {
            menu.insertItem(
                self.makeMessageItem(
                    text: errorText,
                    symbolName: "exclamationmark.triangle",
                    width: width,
                    maxLines: 2),
                at: cursor)
            cursor += 1
        }

        if rows.isEmpty {
            menu.insertItem(
                self.makeMessageItem(text: errorText ?? "No usage available", symbolName: "minus", width: width),
                at: cursor)
            cursor += 1
            return cursor
        }

        if let selectedProvider = self.selectedUsageProviderId,
           let primary = rows.first(where: { $0.providerId.lowercased() == selectedProvider }),
           rows.count > 1
        {
            let others = rows.filter { $0.providerId.lowercased() != selectedProvider }

            let item = NSMenuItem()
            item.tag = self.tag
            item.isEnabled = true
            if !others.isEmpty {
                item.submenu = self.buildUsageOverflowMenu(rows: others, width: width)
            }
            item.view = self.makeHostedView(
                rootView: AnyView(UsageMenuLabelView(row: primary, width: width, showsChevron: !others.isEmpty)),
                width: width,
                highlighted: true)
            menu.insertItem(item, at: cursor)
            cursor += 1

            return cursor
        }

        for row in rows {
            let item = NSMenuItem()
            item.tag = self.tag
            item.isEnabled = false
            item.view = self.makeHostedView(
                rootView: AnyView(UsageMenuLabelView(row: row, width: width)),
                width: width,
                highlighted: false)
            menu.insertItem(item, at: cursor)
            cursor += 1
        }

        return cursor
    }

    private var selectedUsageProviderId: String? {
        guard let model = self.cachedSnapshot?.defaults.model.nonEmpty else { return nil }
        let trimmed = model.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let slash = trimmed.firstIndex(of: "/") else { return nil }
        let provider = trimmed[..<slash].trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return provider.nonEmpty
    }

    private var usageRows: [UsageRow] {
        guard let summary = self.cachedUsageSummary else { return [] }
        return summary.primaryRows()
    }

    private func buildUsageOverflowMenu(rows: [UsageRow], width: CGFloat) -> NSMenu {
        let menu = NSMenu()
        for row in rows {
            let item = NSMenuItem()
            item.tag = self.tag
            item.isEnabled = false
            item.view = self.makeHostedView(
                rootView: AnyView(UsageMenuLabelView(row: row, width: width)),
                width: width,
                highlighted: false)
            menu.addItem(item)
        }
        return menu
    }

    private var isControlChannelConnected: Bool {
        #if DEBUG
        if let override = self.testControlChannelConnected { return override }
        #endif
        if case .connected = ControlChannel.shared.state { return true }
        return false
    }

    private func controlChannelStatusText(for state: ControlChannel.ConnectionState) -> String {
        switch state {
        case .connected:
            "Loading sessions…"
        case .connecting:
            "Connecting…"
        case let .degraded(message):
            message.nonEmpty ?? "Gateway disconnected"
        case .disconnected:
            "Gateway disconnected"
        }
    }

    private func gatewayEntry() -> NodeInfo? {
        let mode = AppStateStore.shared.connectionMode
        let isConnected = self.isControlChannelConnected
        let port = GatewayEnvironment.gatewayPort()
        var host: String?
        var platform: String?

        switch mode {
        case .remote:
            platform = "remote"
            let target = AppStateStore.shared.remoteTarget
            if let parsed = CommandResolver.parseSSHTarget(target) {
                host = parsed.port == 22 ? parsed.host : "\(parsed.host):\(parsed.port)"
            } else {
                host = target.nonEmpty
            }
        case .local:
            platform = "local"
            host = "127.0.0.1:\(port)"
        case .unconfigured:
            platform = nil
            host = nil
        }

        return NodeInfo(
            nodeId: "gateway",
            displayName: "Gateway",
            platform: platform,
            version: nil,
            deviceFamily: nil,
            modelIdentifier: nil,
            remoteIp: host,
            caps: nil,
            commands: nil,
            permissions: nil,
            paired: nil,
            connected: isConnected)
    }

    private func makeNodeItem(entry: NodeInfo, width: CGFloat) -> NSMenuItem {
        let item = NSMenuItem()
        item.tag = self.nodesTag
        item.target = self
        item.action = #selector(self.copyNodeSummary(_:))
        item.representedObject = NodeMenuEntryFormatter.summaryText(entry)
        item.view = HighlightedMenuItemHostView(
            rootView: AnyView(NodeMenuRowView(entry: entry, width: width)),
            width: width)
        item.submenu = self.buildNodeSubmenu(entry: entry, width: width)
        return item
    }

    private func makeSessionPreviewItem(
        sessionKey: String,
        title: String,
        width: CGFloat,
        maxLines: Int) -> NSMenuItem
    {
        let item = NSMenuItem()
        item.tag = self.tag
        item.isEnabled = false
        let view = AnyView(SessionMenuPreviewView(
                            sessionKey: sessionKey,
                            width: width,
                            maxItems: 10,
                            maxLines: maxLines,
                            title: title))
        item.view = self.makeHostedView(rootView: view, width: width, highlighted: false)
        return item
    }

    private func makeMessageItem(text: String, symbolName: String, width: CGFloat, maxLines: Int? = 2) -> NSMenuItem {
        let view = AnyView(
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: symbolName)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(width: 14, alignment: .leading)
                    .padding(.top, 1)

                Text(text)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.leading)
                    .lineLimit(maxLines)
                    .truncationMode(.tail)
                    .fixedSize(horizontal: false, vertical: true)
                    .layoutPriority(1)
                    .frame(maxWidth: .infinity, alignment: .leading)

                Spacer(minLength: 0)
            }
            .padding(.leading, 18)
            .padding(.trailing, 12)
            .padding(.vertical, 6)
            .frame(width: max(1, width), alignment: .leading))

        let item = NSMenuItem()
        item.tag = self.tag
        item.isEnabled = false
        item.view = self.makeHostedView(rootView: view, width: width, highlighted: false)
        return item
    }
}

extension MenuSessionsInjector {
    // MARK: - Cache

    private func refreshCache(force: Bool) async {
        if !force, let updated = self.cacheUpdatedAt, Date().timeIntervalSince(updated) < self.refreshIntervalSeconds {
            return
        }

        guard self.isControlChannelConnected else {
            self.cachedSnapshot = nil
            self.cachedErrorText = nil
            self.cacheUpdatedAt = Date()
            return
        }

        do {
            self.cachedSnapshot = try await SessionLoader.loadSnapshot(limit: 32)
            self.cachedErrorText = nil
            self.cacheUpdatedAt = Date()
        } catch {
            self.cachedSnapshot = nil
            self.cachedErrorText = self.compactError(error)
            self.cacheUpdatedAt = Date()
        }
    }

    private func refreshUsageCache(force: Bool) async {
        if !force,
           let updated = self.usageCacheUpdatedAt,
           Date().timeIntervalSince(updated) < self.usageRefreshIntervalSeconds
        {
            return
        }

        guard self.isControlChannelConnected else {
            self.cachedUsageSummary = nil
            self.cachedUsageErrorText = nil
            self.usageCacheUpdatedAt = Date()
            return
        }

        do {
            self.cachedUsageSummary = try await UsageLoader.loadSummary()
            self.cachedUsageErrorText = nil
            self.usageCacheUpdatedAt = Date()
        } catch {
            if self.cachedUsageSummary == nil {
                self.cachedUsageErrorText = self.compactUsageError(error)
            }
            self.usageCacheUpdatedAt = Date()
        }
    }

    private func compactUsageError(_ error: Error) -> String {
        let message = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        if message.isEmpty { return "Usage unavailable" }
        if message.count > 90 { return "\(message.prefix(87))…" }
        return message
    }

    private func compactError(_ error: Error) -> String {
        if let loadError = error as? SessionLoadError {
            switch loadError {
            case .gatewayUnavailable:
                return "No connection to gateway"
            case .decodeFailed:
                return "Sessions unavailable"
            }
        }
        return "Sessions unavailable"
    }
}

extension MenuSessionsInjector {
    // MARK: - Submenus

    private func buildSubmenu(for row: SessionRow, storePath: String) -> NSMenu {
        let menu = NSMenu()
        let width = self.submenuWidth()

        menu.addItem(self.makeSessionPreviewItem(
                        sessionKey: row.key,
                        title: "Recent messages (last 10)",
                        width: width,
                        maxLines: 3))

        let morePreview = NSMenuItem(title: "More preview…", action: nil, keyEquivalent: "")
        morePreview.submenu = self.buildPreviewSubmenu(sessionKey: row.key, width: width)
        menu.addItem(morePreview)

        menu.addItem(NSMenuItem.separator())

        let thinking = NSMenuItem(title: "Thinking", action: nil, keyEquivalent: "")
        thinking.submenu = self.buildThinkingMenu(for: row)
        menu.addItem(thinking)

        let verbose = NSMenuItem(title: "Verbose", action: nil, keyEquivalent: "")
        verbose.submenu = self.buildVerboseMenu(for: row)
        menu.addItem(verbose)

        if AppStateStore.shared.debugPaneEnabled,
           AppStateStore.shared.connectionMode == .local,
           let sessionId = row.sessionId,
           !sessionId.isEmpty
        {
            menu.addItem(NSMenuItem.separator())
            let openLog = NSMenuItem(
                title: "Open Session Log",
                action: #selector(self.openSessionLog(_:)),
                keyEquivalent: "")
            openLog.target = self
            openLog.representedObject = [
                "sessionId": sessionId,
                "storePath": storePath,
            ]
            menu.addItem(openLog)
        }

        menu.addItem(NSMenuItem.separator())

        let reset = NSMenuItem(title: "Reset Session", action: #selector(self.resetSession(_:)), keyEquivalent: "")
        reset.target = self
        reset.representedObject = row.key
        menu.addItem(reset)

        let compact = NSMenuItem(
            title: "Compact Session Log",
            action: #selector(self.compactSession(_:)),
            keyEquivalent: "")
        compact.target = self
        compact.representedObject = row.key
        menu.addItem(compact)

        if row.key != self.mainSessionKey, row.key != "global" {
            let del = NSMenuItem(title: "Delete Session", action: #selector(self.deleteSession(_:)), keyEquivalent: "")
            del.target = self
            del.representedObject = row.key
            del.isAlternate = false
            del.keyEquivalentModifierMask = []
            menu.addItem(del)
        }

        return menu
    }

    private func buildThinkingMenu(for row: SessionRow) -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false
        menu.showsStateColumn = true
        let levels: [String] = ["off", "minimal", "low", "medium", "high"]
        let current = levels.contains(row.thinkingLevel ?? "") ? row.thinkingLevel ?? "off" : "off"
        for level in levels {
            let title = level.capitalized
            let item = NSMenuItem(title: title, action: #selector(self.patchThinking(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = [
                "key": row.key,
                "value": level as Any,
            ]
            item.state = (current == level) ? .on : .off
            menu.addItem(item)
        }
        return menu
    }

    private func buildVerboseMenu(for row: SessionRow) -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false
        menu.showsStateColumn = true
        let levels: [String] = ["on", "off"]
        let current = levels.contains(row.verboseLevel ?? "") ? row.verboseLevel ?? "off" : "off"
        for level in levels {
            let title = level.capitalized
            let item = NSMenuItem(title: title, action: #selector(self.patchVerbose(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = [
                "key": row.key,
                "value": level as Any,
            ]
            item.state = (current == level) ? .on : .off
            menu.addItem(item)
        }
        return menu
    }

    private func buildPreviewSubmenu(sessionKey: String, width: CGFloat) -> NSMenu {
        let menu = NSMenu()
        menu.addItem(self.makeSessionPreviewItem(
                        sessionKey: sessionKey,
                        title: "Recent messages (expanded)",
                        width: width,
                        maxLines: 8))
        return menu
    }

    private func buildNodesOverflowMenu(entries: [NodeInfo], width: CGFloat) -> NSMenu {
        let menu = NSMenu()
        for entry in entries {
            let item = NSMenuItem()
            item.target = self
            item.action = #selector(self.copyNodeSummary(_:))
            item.representedObject = NodeMenuEntryFormatter.summaryText(entry)
            item.view = HighlightedMenuItemHostView(
                rootView: AnyView(NodeMenuRowView(entry: entry, width: width)),
                width: width)
            item.submenu = self.buildNodeSubmenu(entry: entry, width: width)
            menu.addItem(item)
        }
        return menu
    }

    private func buildNodeSubmenu(entry: NodeInfo, width: CGFloat) -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false

        menu.addItem(self.makeNodeCopyItem(label: "Node ID", value: entry.nodeId))

        if let name = entry.displayName?.nonEmpty {
            menu.addItem(self.makeNodeCopyItem(label: "Name", value: name))
        }

        if let ip = entry.remoteIp?.nonEmpty {
            menu.addItem(self.makeNodeCopyItem(label: "IP", value: ip))
        }

        menu.addItem(self.makeNodeCopyItem(label: "Status", value: NodeMenuEntryFormatter.roleText(entry)))

        if let platform = NodeMenuEntryFormatter.platformText(entry) {
            menu.addItem(self.makeNodeCopyItem(label: "Platform", value: platform))
        }

        if let version = entry.version?.nonEmpty {
            menu.addItem(self.makeNodeCopyItem(label: "Version", value: self.formatVersionLabel(version)))
        }

        menu.addItem(self.makeNodeDetailItem(label: "Connected", value: entry.isConnected ? "Yes" : "No"))
        menu.addItem(self.makeNodeDetailItem(label: "Paired", value: entry.isPaired ? "Yes" : "No"))

        if let caps = entry.caps?.filter({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }),
           !caps.isEmpty
        {
            menu.addItem(self.makeNodeCopyItem(label: "Caps", value: caps.joined(separator: ", ")))
        }

        if let commands = entry.commands?.filter({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }),
           !commands.isEmpty
        {
            menu.addItem(self.makeNodeMultilineItem(
                            label: "Commands",
                            value: commands.joined(separator: ", "),
                            width: width))
        }

        return menu
    }

    private func makeNodeDetailItem(label: String, value: String) -> NSMenuItem {
        let item = NSMenuItem(title: "\(label): \(value)", action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
    }

    private func makeNodeCopyItem(label: String, value: String) -> NSMenuItem {
        let item = NSMenuItem(title: "\(label): \(value)", action: #selector(self.copyNodeValue(_:)), keyEquivalent: "")
        item.target = self
        item.representedObject = value
        return item
    }

    private func makeNodeMultilineItem(label: String, value: String, width: CGFloat) -> NSMenuItem {
        let item = NSMenuItem()
        item.target = self
        item.action = #selector(self.copyNodeValue(_:))
        item.representedObject = value
        item.view = HighlightedMenuItemHostView(
            rootView: AnyView(NodeMenuMultilineView(label: label, value: value, width: width)),
            width: width)
        return item
    }

    private func formatVersionLabel(_ version: String) -> String {
        let trimmed = version.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return version }
        if trimmed.hasPrefix("v") { return trimmed }
        if let first = trimmed.unicodeScalars.first, CharacterSet.decimalDigits.contains(first) {
            return "v\(trimmed)"
        }
        return trimmed
    }

    @objc
    private func patchThinking(_ sender: NSMenuItem) {
        guard let dict = sender.representedObject as? [String: Any],
              let key = dict["key"] as? String
        else { return }
        let value = dict["value"] as? String
        Task {
            do {
                try await SessionActions.patchSession(key: key, thinking: .some(value))
                await self.refreshCache(force: true)
            } catch {
                await MainActor.run {
                    SessionActions.presentError(title: "Update thinking failed", error: error)
                }
            }
        }
    }

    @objc
    private func patchVerbose(_ sender: NSMenuItem) {
        guard let dict = sender.representedObject as? [String: Any],
              let key = dict["key"] as? String
        else { return }
        let value = dict["value"] as? String
        Task {
            do {
                try await SessionActions.patchSession(key: key, verbose: .some(value))
                await self.refreshCache(force: true)
            } catch {
                await MainActor.run {
                    SessionActions.presentError(title: "Update verbose failed", error: error)
                }
            }
        }
    }

    @objc
    private func openSessionLog(_ sender: NSMenuItem) {
        guard let dict = sender.representedObject as? [String: String],
              let sessionId = dict["sessionId"],
              let storePath = dict["storePath"]
        else { return }
        SessionActions.openSessionLogInCode(sessionId: sessionId, storePath: storePath)
    }

    @objc
    private func resetSession(_ sender: NSMenuItem) {
        guard let key = sender.representedObject as? String else { return }
        Task { @MainActor in
            guard SessionActions.confirmDestructiveAction(
                    title: "Reset session?",
                    message: "Starts a new session id for “\(key)”.",
                    action: "Reset")
            else { return }

            do {
                try await SessionActions.resetSession(key: key)
                await self.refreshCache(force: true)
            } catch {
                SessionActions.presentError(title: "Reset failed", error: error)
            }
        }
    }

    @objc
    private func compactSession(_ sender: NSMenuItem) {
        guard let key = sender.representedObject as? String else { return }
        Task { @MainActor in
            guard SessionActions.confirmDestructiveAction(
                    title: "Compact session log?",
                    message: "Keeps the last 400 lines; archives the old file.",
                    action: "Compact")
            else { return }

            do {
                try await SessionActions.compactSession(key: key, maxLines: 400)
                await self.refreshCache(force: true)
            } catch {
                SessionActions.presentError(title: "Compact failed", error: error)
            }
        }
    }

    @objc
    private func deleteSession(_ sender: NSMenuItem) {
        guard let key = sender.representedObject as? String else { return }
        Task { @MainActor in
            guard SessionActions.confirmDestructiveAction(
                    title: "Delete session?",
                    message: "Deletes the “\(key)” entry and archives its transcript.",
                    action: "Delete")
            else { return }

            do {
                try await SessionActions.deleteSession(key: key)
                await self.refreshCache(force: true)
            } catch {
                SessionActions.presentError(title: "Delete failed", error: error)
            }
        }
    }

    @objc
    private func copyNodeSummary(_ sender: NSMenuItem) {
        guard let summary = sender.representedObject as? String else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(summary, forType: .string)
    }

    @objc
    private func copyNodeValue(_ sender: NSMenuItem) {
        guard let value = sender.representedObject as? String else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(value, forType: .string)
    }
}

extension MenuSessionsInjector {
    // MARK: - Width + placement

    private func findInsertIndex(in menu: NSMenu) -> Int? {
        // Insert right before the separator above "Send Heartbeats".
        if let idx = menu.items.firstIndex(where: { $0.title == "Send Heartbeats" }) {
            if let sepIdx = menu.items[..<idx].lastIndex(where: { $0.isSeparatorItem }) {
                return sepIdx
            }
            return idx
        }

        if let sepIdx = menu.items.firstIndex(where: { $0.isSeparatorItem }) {
            return sepIdx
        }

        if menu.items.count >= 1 { return 1 }
        return menu.items.count
    }

    private func findNodesInsertIndex(in menu: NSMenu) -> Int? {
        if let idx = menu.items.firstIndex(where: { $0.title == "Send Heartbeats" }) {
            if let sepIdx = menu.items[..<idx].lastIndex(where: { $0.isSeparatorItem }) {
                return sepIdx
            }
            return idx
        }

        if let sepIdx = menu.items.firstIndex(where: { $0.isSeparatorItem }) {
            return sepIdx
        }

        if menu.items.count >= 1 { return 1 }
        return menu.items.count
    }

    private func initialWidth(for menu: NSMenu) -> CGFloat {
        if let openWidth = self.menuOpenWidth {
            return max(300, openWidth)
        }
        return self.currentMenuWidth(for: menu)
    }

    private func submenuWidth() -> CGFloat {
        if let openWidth = self.menuOpenWidth {
            return max(300, openWidth)
        }
        if let cached = self.lastKnownMenuWidth {
            return max(300, cached)
        }
        return self.fallbackWidth
    }

    private func menuWindowWidth(for menu: NSMenu) -> CGFloat? {
        var menuWindow: NSWindow?
        for item in menu.items {
            if let window = item.view?.window {
                menuWindow = window
                break
            }
        }
        guard let width = menuWindow?.contentView?.bounds.width, width > 0 else { return nil }
        return width
    }

    private func sortedNodeEntries() -> [NodeInfo] {
        let entries = self.nodesStore.nodes.filter(\.isConnected)
        return entries.sorted { lhs, rhs in
            if lhs.isConnected != rhs.isConnected { return lhs.isConnected }
            if lhs.isPaired != rhs.isPaired { return lhs.isPaired }
            let lhsName = NodeMenuEntryFormatter.primaryName(lhs).lowercased()
            let rhsName = NodeMenuEntryFormatter.primaryName(rhs).lowercased()
            if lhsName == rhsName { return lhs.nodeId < rhs.nodeId }
            return lhsName < rhsName
        }
    }
}

extension MenuSessionsInjector {
    // MARK: - Views

    private func makeHostedView(rootView: AnyView, width: CGFloat, highlighted: Bool) -> NSView {
        if highlighted {
            let container = HighlightedMenuItemHostView(rootView: rootView, width: width)
            return container
        }

        let hosting = NSHostingView(rootView: rootView)
        hosting.frame.size.width = max(1, width)
        let size = hosting.fittingSize
        hosting.frame = NSRect(origin: .zero, size: NSSize(width: width, height: size.height))
        return hosting
    }

    private func captureMenuWidthIfAvailable(from view: NSView) {
        guard !self.isMenuOpen else { return }
        guard let width = view.window?.contentView?.bounds.width, width > 0 else { return }
        self.lastKnownMenuWidth = max(300, width)
    }

    private func currentMenuWidth(for menu: NSMenu) -> CGFloat {
        if let width = self.menuWindowWidth(for: menu) {
            return max(300, width)
        }
        let candidates: [CGFloat] = [
            menu.size.width,
            menu.minimumWidth,
            self.lastKnownMenuWidth ?? 0,
            self.fallbackWidth,
        ]
        let resolved = candidates.max() ?? self.fallbackWidth
        return max(300, resolved)
    }
}

#if DEBUG
extension MenuSessionsInjector {
    func setTestingControlChannelConnected(_ connected: Bool?) {
        self.testControlChannelConnected = connected
    }

    func setTestingSnapshot(_ snapshot: SessionStoreSnapshot?, errorText: String? = nil) {
        self.cachedSnapshot = snapshot
        self.cachedErrorText = errorText
        self.cacheUpdatedAt = Date()
    }

    func setTestingUsageSummary(_ summary: GatewayUsageSummary?, errorText: String? = nil) {
        self.cachedUsageSummary = summary
        self.cachedUsageErrorText = errorText
        self.usageCacheUpdatedAt = Date()
    }

    func injectForTesting(into menu: NSMenu) {
        self.inject(into: menu)
    }
}
#endif
