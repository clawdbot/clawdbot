import AppKit
import Foundation
import Observation
import OpenClawKit
import QuartzCore

@MainActor
@Observable
final class StatusMenuSummaries: NSObject {
    static let shared = StatusMenuSummaries()

    @ObservationIgnored private let nodes: NodesStore
    @ObservationIgnored private let cron: CronJobsStore
    @ObservationIgnored private let control: ControlChannel
    private struct UsageState {
        let revision: UInt64?
        var lease: GatewayConnection.ServerLease?
        var usage: GatewayUsageSummary?
        var cost: GatewayCostUsageSummary?
        var costError: String?
        var usageUpdatedAt: Date?
        var costUpdatedAt: Date?
        var retryAttempts = 0
        var pending = false
    }

    @MainActor
    private final class Refresh {
        let revision: UInt64?
        var lease: GatewayConnection.ServerLease?
        var task: Task<Void, Never>?

        init(revision: UInt64?) {
            self.revision = revision
        }
    }

    private var usageState: UsageState?
    @ObservationIgnored private var refreshOperation: Refresh?
    @ObservationIgnored private var eventTask: Task<Void, Never>?
    @ObservationIgnored private var updateHandler: (@MainActor () -> Void)?
    @ObservationIgnored private var copiedValues: [String: String] = [:]
    private let usageRetryLimit = 3

    /// AppKit projects the cache before starting network work. Keep its TTL only
    /// for the selected logical Gateway, including reconnects to that same route.
    private var currentUsageState: UsageState? {
        guard let state = self.usageState,
              state.revision == self.control.gateway.selectedEndpointRevision,
              state.lease.map(self.control.gateway.serverLeaseMatchesCurrentRoute) != false
        else { return nil }
        return state
    }

    private var cachedUsage: GatewayUsageSummary? {
        self.currentUsageState?.usage
    }

    private var cachedCost: GatewayCostUsageSummary? {
        self.currentUsageState?.cost
    }

    private var costError: String? {
        self.currentUsageState?.costError
    }

    private var usageRefreshPending: Bool {
        self.currentUsageState?.pending == true
    }

    init(control: ControlChannel = .shared, nodes: NodesStore = .shared, cron: CronJobsStore = .shared) {
        self.control = control
        self.nodes = nodes
        self.cron = cron
        super.init()
    }

    var hasUsage: Bool {
        !self.usageRows.isEmpty || self.cachedCost != nil || self.cachedUsage?.refreshing == true
            || self.usageRefreshPending
    }

    var isUsageStalled: Bool {
        guard let state = self.currentUsageState else { return false }
        return self.isConnected && state.usage?.refreshing == true && state.retryAttempts >= self.usageRetryLimit
    }

    var usageSummary: String? {
        let rows = self.usageRows
        guard let row = rows.first(where: { $0.providerId.lowercased() == self.selectedProviderID }) ?? rows.first
        else { return nil }
        return "\(row.titleText) · \(row.detailText())"
    }

    var connectedDeviceCount: Int {
        self.nodes.nodes.filter(\.isConnected).count
    }

    func refresh(onUpdate: @escaping @MainActor () -> Void) {
        self.updateHandler = onUpdate
        self.nodes.start()
        self.cron.start()
        if self.eventTask == nil {
            GatewayPushSubscription.restartTask(
                task: &self.eventTask,
                connection: self.control.gateway)
            { [weak self] delivery in
                self?.handle(delivery)
            }
        }
        if self.isConnected { self.beginRefresh() }
    }

    func menuDidClose() {
        self.updateHandler = nil
        self.nodes.stop()
        self.cron.stop()
        SimpleTaskSupport.stop(task: &self.eventTask)
        self.cancelRefresh()
        self.usageState?.retryAttempts = 0
    }

    isolated deinit {
        self.eventTask?.cancel()
        self.refreshOperation?.task?.cancel()
    }

    private func handle(_ delivery: GatewayConnection.PushDelivery) {
        // Discard retired data at the delivery boundary while keeping the cache
        // across reconnects to the same logical Gateway.
        if self.usageState != nil, self.currentUsageState == nil {
            self.usageState = nil
        }
        guard let push = delivery.push else {
            if self.refreshOperation?.lease == delivery.serverLease { self.cancelRefresh() }
            return
        }
        guard case .snapshot = push else { return }
        // Our own admission receives a hello before dispatching the reads.
        if let refresh = self.refreshOperation, self.isCurrent(refresh),
           refresh.lease == nil || refresh.lease == delivery.serverLease { return }
        if self.currentUsageState?.lease == delivery.serverLease { return }
        self.beginRefresh()
    }

    func configureAutomations(_ item: NSMenuItem) {
        let jobs = self.enabledJobs
        let detail = if let next = jobs.compactMap(\.nextRunDate).min() {
            "\(jobs.count) · \(Self.relativeRun(next))"
        } else {
            String(jobs.count)
        }
        item.title = String(localized: "Automations")
        item.image = nil
        StatusMenuRenderer.configureHostedView(
            item,
            rootView: StatusSummaryCard(
                symbolName: "clock.badge.checkmark",
                title: String(localized: "Automations"),
                detail: detail),
            highlights: true)

        var entries = jobs.prefix(8).map { job in
            MenuEntry(id: "cron.job.\(job.id)") { [weak self] item in
                item.title = job.displayName
                item.target = self
                item.action = #selector(Self.openAutomations(_:))
                item.isEnabled = true
                StatusMenuRenderer.configureHostedView(
                    item,
                    rootView: StatusJobRow(
                        name: job.displayName,
                        nextRun: job.nextRunDate.map(Self.relativeRun)),
                    highlights: true)
            }
        }
        if !entries.isEmpty {
            entries.append(.separator(id: "cron.separator"))
        }
        entries.append(MenuEntry(id: "cron.open") { [weak self] item in
            item.title = String(localized: "Open Automations…")
            item.target = self
            item.action = #selector(Self.openAutomations(_:))
            item.isEnabled = true
        })
        self.reconcileSubmenu(for: item, entries: entries)
    }

    func configureUsage(_ item: NSMenuItem) {
        item.title = String(localized: "Usage")
        item.image = nil
        StatusMenuRenderer.configureHostedView(
            item,
            rootView: StatusSummaryCard(
                symbolName: "chart.bar.xaxis",
                title: String(localized: "Usage"),
                detail: self.usageSummary),
            highlights: true)

        var entries = self.orderedUsageRows.map { row in
            MenuEntry(id: "usage.provider.\(row.id)") { item in
                item.title = StatusMenuMetrics.fittedTitle(row.titleText)
                item.isEnabled = false
                StatusMenuRenderer.configureHostedView(item, rootView: UsageMenuLabelView(row: row))
            }
        }

        if self.isUsageStalled, entries.isEmpty {
            entries.append(.info(
                id: "usage.stalled",
                title: String(localized: "Usage did not finish loading. Close and reopen this menu to retry.")))
        } else if entries.isEmpty, self.usageRefreshPending || self.cachedUsage?.refreshing == true {
            entries.append(.info(id: "usage.loading", title: String(localized: "Loading usage…")))
        }

        if let summary = self.cachedCost, !summary.daily.isEmpty {
            if !entries.isEmpty {
                entries.append(.separator(id: "usage.cost.separator"))
            }
            entries.append(MenuEntry(id: "usage.cost.chart") { item in
                item.title = String(localized: "Usage cost (30 days)")
                item.isEnabled = false
                StatusMenuRenderer.configureHostedView(item, rootView: CostUsageHistoryMenuView(summary: summary))
            })
        } else if let error = self.costError {
            if !entries.isEmpty {
                entries.append(.separator(id: "usage.cost.separator"))
            }
            entries.append(.info(id: "usage.cost.error", title: error))
        }
        self.reconcileSubmenu(for: item, entries: entries)
    }

    func configureDevices(_ item: NSMenuItem) {
        let count = self.connectedDeviceCount
        item.title = String(localized: "Devices")
        item.image = nil
        StatusMenuRenderer.configureHostedView(
            item,
            rootView: StatusSummaryCard(
                symbolName: "laptopcomputer.and.iphone",
                title: String(localized: "Devices"),
                detail: String(format: String(localized: "%lld connected"), count)),
            highlights: true)

        var entries: [MenuEntry] = []
        if let gateway = self.gatewayEntry() {
            entries.append(self.nodeEntry(gateway))
        }
        if let notice = self.nodes.persistentServiceNotice {
            entries.append(.info(id: "devices.service.notice", title: notice))
        }

        if case .connecting = self.control.state {
            entries.append(.info(id: "devices.connecting", title: String(localized: "Connecting…")))
        } else if self.isConnected {
            if let error = self.nodes.lastError?.nonEmpty {
                entries.append(.info(id: "devices.error", title: String(format: String(localized: "Error: %@"), error)))
            } else if let message = self.nodes.statusMessage?.nonEmpty {
                entries.append(.info(id: "devices.status", title: message))
            }

            let devices = self.sortedNodes
            if devices.isEmpty {
                entries.append(.info(
                    id: "devices.empty",
                    title: self.nodes.isLoading
                        ? String(localized: "Loading devices…")
                        : String(localized: "No devices yet")))
            } else {
                entries.append(contentsOf: devices.prefix(8).map(self.nodeEntry))
                if devices.count > 8 {
                    let overflow = Array(devices.dropFirst(8))
                    entries.append(MenuEntry(id: "devices.overflow") { [weak self] item in
                        item.title = String(localized: "More Devices…")
                        item.image = NSImage(systemSymbolName: "ellipsis.circle", accessibilityDescription: nil)
                        self?.reconcileSubmenu(for: item, entries: overflow.compactMap { self?.nodeEntry($0) })
                    })
                }
            }
        }
        self.reconcileSubmenu(for: item, entries: entries)
    }

    func configureGateway(_ item: NSMenuItem, gateway: DashboardGatewayMenuItem, isAlternate: Bool) {
        item.identifier = NSUserInterfaceItemIdentifier(gateway.id)
        item.target = self
        item.isAlternate = isAlternate
        if isAlternate {
            item.title = String(format: String(localized: "Set %@ as Primary…"), gateway.name)
            item.action = #selector(Self.setPrimary(_:))
            item.keyEquivalentModifierMask = [.option]
            item.image = nil
            item.state = .off
        } else {
            item.title = gateway.name
            item.action = #selector(Self.openGateway(_:))
            item.keyEquivalentModifierMask = []
            item.image = Self.gatewayImage(health: gateway.health, name: gateway.name)
            item.state = gateway.isPrimary ? .on : .off
        }
        item.title = StatusMenuMetrics.fittedTitle(item.title)
    }

    private var enabledJobs: [CronJob] {
        self.cron.jobs.filter(\.enabled).sorted { lhs, rhs in
            (lhs.nextRunDate ?? .distantFuture) < (rhs.nextRunDate ?? .distantFuture)
        }
    }

    private var usageRows: [UsageRow] {
        self.cachedUsage?.primaryRows() ?? []
    }

    private var orderedUsageRows: [UsageRow] {
        let rows = self.usageRows
        guard let selected = self.selectedProviderID,
              let primary = rows.first(where: { $0.providerId.lowercased() == selected })
        else { return rows }
        return [primary] + rows.filter { $0.id != primary.id }
    }

    private var selectedProviderID: String? {
        guard let model = StatusMenuSessions.shared.cachedSnapshot?.defaults.model.nonEmpty,
              let slash = model.firstIndex(of: "/")
        else { return nil }
        return model[..<slash].trimmingCharacters(in: .whitespacesAndNewlines).lowercased().nonEmpty
    }

    private var isConnected: Bool {
        if case .connected = self.control.state { return true }
        return false
    }

    private func beginRefresh() {
        if let refresh = self.refreshOperation, self.isCurrent(refresh) { return }
        self.cancelRefresh()
        var state = self.currentUsageState ?? UsageState(revision: self.control.gateway.selectedEndpointRevision)
        let loadUsage = state.usageUpdatedAt.map { Date().timeIntervalSince($0) >= 30 } ?? true
        let loadCost = state.costUpdatedAt.map { Date().timeIntervalSince($0) >= 45 } ?? true
        guard loadUsage || loadCost else { return }
        state.pending = loadUsage
        state.retryAttempts = 0
        self.usageState = state
        let refresh = Refresh(revision: state.revision)
        refresh.task = Task { [weak self] in
            await self?.performRefresh(refresh, loadUsage: loadUsage, loadCost: loadCost)
        }
        self.refreshOperation = refresh
    }

    private func cancelRefresh() {
        self.refreshOperation?.task?.cancel()
        self.refreshOperation = nil
        self.usageState?.pending = false
    }

    private func isCurrent(_ refresh: Refresh) -> Bool {
        self.refreshOperation === refresh && refresh.task?.isCancelled != true &&
            refresh.revision == self.control.gateway.selectedEndpointRevision &&
            refresh.lease.map(self.control.gateway.serverLeaseMatchesCurrentState) != false
    }

    private func performRefresh(_ refresh: Refresh, loadUsage: Bool, loadCost: Bool) async {
        defer {
            if self.refreshOperation === refresh {
                self.refreshOperation = nil
                self.usageState?.pending = false
            }
        }
        guard self.isCurrent(refresh) else { return }
        do {
            let lease = try await self.control.acquireServerLease()
            guard self.isCurrent(refresh), self.control.gateway.serverLeaseMatchesCurrentState(lease) else { return }
            refresh.lease = lease
            self.usageState?.lease = lease
            async let usage: Void = self.loadUsage(refresh, enabled: loadUsage)
            async let cost: Void = self.loadCost(refresh, enabled: loadCost)
            _ = await (usage, cost)
        } catch {
            guard self.isCurrent(refresh), !(error is CancellationError) else { return }
            if loadUsage {
                self.usageState?.usage = nil
                self.usageState?.usageUpdatedAt = Date()
            }
            if loadCost { self.recordCostFailure(error) }
            self.updateHandler?()
        }
    }

    private func loadUsage(_ refresh: Refresh, enabled: Bool) async {
        guard enabled, let lease = refresh.lease else { return }
        while self.isCurrent(refresh) {
            do {
                let data = try await self.control.request(
                    method: "usage.status", timeoutMs: 5000, ifCurrentServerLease: lease)
                guard self.isCurrent(refresh) else { return }
                self.usageState?.usage = try JSONDecoder().decode(GatewayUsageSummary.self, from: data)
            } catch {
                guard self.isCurrent(refresh) else { return }
                if self.cachedUsage?.refreshing != true { self.usageState?.usage = nil }
            }
            guard self.cachedUsage?.refreshing == true else {
                self.usageState?.pending = false
                self.usageState?.usageUpdatedAt = Date()
                self.updateHandler?()
                return
            }
            self.usageState?.usageUpdatedAt = nil
            guard (self.usageState?.retryAttempts ?? 0) < self.usageRetryLimit else {
                self.usageState?.pending = false
                self.updateHandler?()
                return
            }
            self.usageState?.retryAttempts += 1
            self.updateHandler?()
            try? await Task.sleep(for: .seconds(5))
            guard self.isConnected else { return }
        }
    }

    private func loadCost(_ refresh: Refresh, enabled: Bool) async {
        guard enabled, self.isCurrent(refresh), let lease = refresh.lease else { return }
        do {
            let data = try await self.control.request(
                method: "usage.cost", timeoutMs: 7000, ifCurrentServerLease: lease)
            guard self.isCurrent(refresh) else { return }
            self.usageState?.cost = try JSONDecoder().decode(GatewayCostUsageSummary.self, from: data)
            self.usageState?.costError = nil
            self.usageState?.costUpdatedAt = Date()
        } catch {
            guard self.isCurrent(refresh) else { return }
            self.recordCostFailure(error)
        }
        self.updateHandler?()
    }

    private func recordCostFailure(_ error: Error) {
        self.usageState?.cost = nil
        let message = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        self.usageState?.costError = message.isEmpty
            ? String(localized: "Usage unavailable")
            : (message.count > 90 ? "\(message.prefix(87))…" : message)
        self.usageState?.costUpdatedAt = Date()
    }

    private static func relativeRun(_ date: Date) -> String {
        let delta = date.timeIntervalSinceNow
        if delta <= 0 { return String(localized: "due") }
        if delta < 60 { return String(localized: "in <1m") }
        let minutes = Int(round(delta / 60))
        if minutes < 60 { return String(format: String(localized: "in %lldm"), minutes) }
        let hours = Int(round(Double(minutes) / 60))
        if hours < 48 { return String(format: String(localized: "in %lldh"), hours) }
        return String(format: String(localized: "in %lldd"), Int(round(Double(hours) / 24)))
    }

    @objc
    private func openAutomations(_: NSMenuItem) {
        Task { await DashboardManager.shared.show(atPath: DashboardRouteMap.cronJobsPagePath) }
    }

    @objc
    private func openGateway(_ sender: NSMenuItem) {
        guard let id = sender.identifier?.rawValue, let target = DashboardGatewayTarget(bridgeID: id) else { return }
        DashboardManager.shared.openOrFocusDashboard(for: target)
    }

    @objc
    private func setPrimary(_ sender: NSMenuItem) {
        guard let id = sender.identifier?.rawValue, let target = DashboardGatewayTarget(bridgeID: id) else { return }
        DashboardManager.shared.confirmSetPrimary(target)
    }

    private static func gatewayImage(health: DashboardGatewayHealth, name: String) -> NSImage? {
        let (symbol, color, accessibility): (String, NSColor, String) = switch health {
        case .ok:
            ("circle.fill", .systemGreen, String(format: String(localized: "%@, healthy"), name))
        case .error:
            ("exclamationmark.circle.fill", .systemRed, String(format: String(localized: "%@, health error"), name))
        case .unknown:
            ("circle", .tertiaryLabelColor, String(format: String(localized: "%@, health unknown"), name))
        }
        return NSImage(systemSymbolName: symbol, accessibilityDescription: accessibility)?
            .withSymbolConfiguration(.init(paletteColors: [color]))
    }
}

extension StatusMenuSummaries {
    private var sortedNodes: [NodeInfo] {
        self.nodes.nodes.filter { $0.isConnected || $0.isPaired }.sorted { lhs, rhs in
            if lhs.isConnected != rhs.isConnected { return lhs.isConnected }
            if lhs.isPaired != rhs.isPaired { return lhs.isPaired }
            let lhsName = NodeMenuEntryFormatter.primaryName(lhs).lowercased()
            let rhsName = NodeMenuEntryFormatter.primaryName(rhs).lowercased()
            return lhsName == rhsName ? lhs.nodeId < rhs.nodeId : lhsName < rhsName
        }
    }

    private func gatewayEntry() -> NodeInfo? {
        let mode = AppStateStore.shared.connectionMode
        var host: String?
        let platform: String?

        switch mode {
        case .remote:
            platform = "remote"
            if AppStateStore.shared.remoteTransport == .direct {
                let raw = AppStateStore.shared.remoteUrl.trimmingCharacters(in: .whitespacesAndNewlines)
                if let url = URL(string: raw), let urlHost = url.host, !urlHost.isEmpty {
                    host = url.port.map { "\(urlHost):\($0)" } ?? urlHost
                } else {
                    host = raw.nonEmpty
                }
            } else {
                let target = AppStateStore.shared.remoteTarget
                if let parsed = CommandResolver.parseSSHTarget(target) {
                    host = parsed.port == 22 ? parsed.host : "\(parsed.host):\(parsed.port)"
                } else {
                    host = target.nonEmpty
                }
            }
        case .local:
            platform = "local"
            host = GatewayConnectivityCoordinator.shared.localEndpointHostLabel
                ?? "127.0.0.1:\(GatewayEnvironment.gatewayPort())"
        case .unconfigured:
            platform = nil
            host = nil
        }

        return NodeInfo(
            nodeId: "gateway",
            displayName: String(localized: "Gateway"),
            platform: platform,
            version: nil,
            coreVersion: nil,
            uiVersion: nil,
            deviceFamily: nil,
            modelIdentifier: nil,
            remoteIp: host,
            caps: nil,
            commands: nil,
            permissions: nil,
            paired: nil,
            connected: self.isConnected)
    }

    private func nodeEntry(_ node: NodeInfo) -> MenuEntry {
        MenuEntry(id: "devices.node.\(node.nodeId)") { [weak self] item in
            item.title = StatusMenuMetrics.fittedTitle(NodeMenuEntryFormatter.primaryName(node))
            item.target = self
            item.action = #selector(Self.copyNodeValue(_:))
            item.isEnabled = true
            if let id = item.representedObject as? String {
                self?.copiedValues[id] = NodeMenuEntryFormatter.summaryText(node)
            }
            StatusMenuRenderer.configureHostedView(item, rootView: NodeMenuRowView(entry: node), highlights: true)
            self?.configureNodeSubmenu(for: item, node: node)
        }
    }

    private func configureNodeSubmenu(for item: NSMenuItem, node: NodeInfo) {
        var entries = [self.copyEntry(node: node, id: "id", label: String(localized: "Node ID"), value: node.nodeId)]
        if let name = node.displayName?.nonEmpty {
            entries.append(self.copyEntry(node: node, id: "name", label: String(localized: "Name"), value: name))
        }
        if let ip = node.remoteIp?.nonEmpty {
            entries.append(self.copyEntry(node: node, id: "ip", label: String(localized: "IP"), value: ip))
        }
        entries.append(self.copyEntry(
            node: node,
            id: "status",
            label: String(localized: "Status"),
            value: NodeMenuEntryFormatter.roleText(node)))
        if let platform = NodeMenuEntryFormatter.platformText(node) {
            entries.append(self.copyEntry(
                node: node, id: "platform", label: String(localized: "Platform"), value: platform))
        }
        if let version = NodeMenuEntryFormatter.detailRightVersion(node)?.nonEmpty {
            entries.append(self.copyEntry(
                node: node, id: "version", label: String(localized: "Version"), value: version))
        }
        entries.append(.info(
            id: "devices.node.\(node.nodeId).connected",
            title: node.isConnected ? String(localized: "Connected: Yes") : String(localized: "Connected: No")))
        entries.append(.info(
            id: "devices.node.\(node.nodeId).paired",
            title: node.isPaired ? String(localized: "Paired: Yes") : String(localized: "Paired: No")))

        if let capabilities = node.caps?.filter({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }),
           !capabilities.isEmpty
        {
            entries.append(self.copyEntry(
                node: node,
                id: "capabilities",
                label: String(localized: "Caps"),
                value: capabilities.joined(separator: ", ")))
        }
        if let commands = node.commands?.filter({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }),
           !commands.isEmpty
        {
            entries.append(self.copyEntry(
                node: node,
                id: "commands",
                label: String(localized: "Commands"),
                value: commands.joined(separator: ", ")))
        }
        self.reconcileSubmenu(for: item, entries: entries)
    }

    private func copyEntry(node: NodeInfo, id: String, label: String, value: String) -> MenuEntry {
        let entryID = "devices.node.\(node.nodeId).\(id)"
        self.copiedValues[entryID] = value
        return MenuEntry(id: entryID) { [weak self] item in
            item.title = StatusMenuMetrics.fittedTitle("\(label): \(value)")
            item.target = self
            item.action = #selector(Self.copyNodeValue(_:))
            item.isEnabled = true
        }
    }

    @objc
    private func copyNodeValue(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String, let value = self.copiedValues[id] else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(value, forType: .string)
    }
}

extension StatusMenuSummaries {
    private struct MenuEntry {
        let id: String
        var isSeparator = false
        var update: @MainActor (NSMenuItem) -> Void

        static func separator(id: String) -> Self {
            Self(id: id, isSeparator: true, update: { _ in })
        }

        static func info(id: String, title: String) -> Self {
            Self(id: id) { item in
                item.title = StatusMenuMetrics.fittedTitle(title)
                item.isEnabled = false
            }
        }
    }

    private func reconcileSubmenu(for parent: NSMenuItem, entries: [MenuEntry]) {
        let menu: NSMenu
        if let existing = parent.submenu {
            menu = existing
        } else {
            menu = NSMenu()
            menu.autoenablesItems = false
            menu.delegate = StatusMenuHighlightDelegate.shared
            StatusMenuAppearance.pin(menu)
            parent.submenu = menu
        }

        let oldIDs = menu.items.map { $0.representedObject as? String ?? "" }
        let newIDs = entries.map(\.id)
        let sharedCount = min(oldIDs.count, newIDs.count)
        var prefix = 0
        while prefix < sharedCount, oldIDs[prefix] == newIDs[prefix] {
            prefix += 1
        }
        var suffix = 0
        while suffix < sharedCount - prefix,
              oldIDs[oldIDs.count - 1 - suffix] == newIDs[newIDs.count - 1 - suffix]
        {
            suffix += 1
        }

        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for index in stride(from: oldIDs.count - suffix - 1, through: prefix, by: -1) where index >= prefix {
            menu.removeItem(at: index)
        }
        for index in prefix..<(entries.count - suffix) {
            let entry = entries[index]
            let item = entry.isSeparator ? NSMenuItem.separator() : NSMenuItem()
            item.representedObject = entry.id
            entry.update(item)
            menu.insertItem(item, at: index)
        }
        for index in 0..<prefix {
            entries[index].update(menu.item(at: index)!)
        }
        for index in (entries.count - suffix)..<entries.count {
            entries[index].update(menu.item(at: index)!)
        }
        CATransaction.commit()
    }
}
