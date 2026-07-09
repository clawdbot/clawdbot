import AppKit
import SwiftUI

/// Floating approval UI listing every pending pairing request as a card.
/// Liquid Glass surface on macOS 26+, material fallback on macOS 15.
struct PairingApprovalPanelView: View {
    let center: PairingApprovalCenter

    /// Transparent margin around the glass so the drawn shadow has room;
    /// the NSPanel shadow is disabled (it would trace a square window edge).
    static let shadowMargin: CGFloat = 32

    var body: some View {
        self.surface
            .frame(width: PairingApprovalPanelController.panelWidth)
            .compositingGroup()
            .shadow(color: .black.opacity(0.28), radius: 22, x: 0, y: 10)
            .padding(Self.shadowMargin)
    }

    @ViewBuilder
    private var surface: some View {
        if #available(macOS 26.0, *) {
            self.content
                .glassEffect(.regular, in: .rect(cornerRadius: 24))
        } else {
            self.content
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 24))
        }
    }

    private var content: some View {
        let cards = self.center.cards
        return VStack(alignment: .leading, spacing: 12) {
            self.header(cards: cards)
            // Every request renders and stays actionable; the scroll plus the
            // controller's screen-height clamp bound hostile queue sizes.
            ScrollView(.vertical) {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(cards) { card in
                        PairingRequestCardView(
                            card: card,
                            isBusy: self.center.decisionsInFlight.contains(card.requestId),
                            isOnlyRequest: cards.count == 1,
                            onDecision: { self.center.decide(card, $0) })
                    }
                }
            }
            .scrollBounceBehavior(.basedOnSize)
            HStack {
                Spacer()
                Button("Not Now") { self.center.snooze() }
                    .keyboardShortcut(.cancelAction)
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(18)
    }

    private func header(cards: [PairingApprovalCenter.Card]) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "checkmark.shield")
                .font(.system(size: 22, weight: .medium))
                .foregroundStyle(.tint)
            VStack(alignment: .leading, spacing: 1) {
                Text(cards.count == 1 ? "Pairing Request" : "Pairing Requests")
                    .font(.title3.weight(.semibold))
                Text(PairingCardPresentation.headerSummary(for: cards))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
    }
}

struct PairingRequestCardView: View {
    let card: PairingApprovalCenter.Card
    let isBusy: Bool
    let isOnlyRequest: Bool
    let onDecision: (PairingApprovalCenter.Decision) -> Void

    @State private var isHoveringDetail = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                self.icon
                VStack(alignment: .leading, spacing: 2) {
                    Text(PairingCardPresentation.title(for: self.card))
                        .font(.headline)
                        .lineLimit(1)
                    if let subtitle = PairingCardPresentation.subtitle(for: self.card) {
                        Text(subtitle)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
            }

            self.trustRow
            self.accessRows
            self.detailRow

            HStack(spacing: 8) {
                Spacer()
                self.rejectButton
                self.approveButton
            }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 16).fill(.quinary))
        .disabled(self.isBusy)
        .opacity(self.isBusy ? 0.6 : 1)
    }

    private var icon: some View {
        Image(systemName: PairingCardPresentation.deviceSymbol(for: self.card))
            .font(.system(size: 20, weight: .medium))
            .frame(width: 42, height: 42)
            .background(Circle().fill(.quaternary))
    }

    private var trustRow: some View {
        let trust = PairingCardPresentation.trustLine(for: self.card)
        return Label(trust.text, systemImage: trust.symbol)
            .font(.caption)
            .foregroundStyle(self.trustStyle(trust.tone))
    }

    private func trustStyle(_ tone: PairingCardPresentation.TrustTone) -> AnyShapeStyle {
        switch tone {
        case .caution: AnyShapeStyle(.orange)
        case .neutral: AnyShapeStyle(.secondary)
        }
    }

    @ViewBuilder
    private var accessRows: some View {
        // Every requested scope/capability renders: hiding one behind a cap
        // could conceal what approval grants. The panel scrolls when long.
        let rows = PairingCardPresentation.accessRows(for: self.card)
        if !rows.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(rows) { row in
                    Label(row.text, systemImage: row.symbol)
                        .font(.caption)
                        .foregroundStyle(
                            row.isElevated ? AnyShapeStyle(.orange) : AnyShapeStyle(.primary))
                }
            }
        }
    }

    private var detailRow: some View {
        HStack(spacing: 4) {
            Text(PairingCardPresentation.identityLine(for: self.card))
                .font(.caption.monospaced())
                .foregroundStyle(.tertiary)
                .lineLimit(1)
                .truncationMode(.middle)
            // Hover-only copy affordance; stays out of the keyboard focus loop.
            Button {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(self.card.subjectId, forType: .string)
            } label: {
                Image(systemName: "doc.on.doc")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            .buttonStyle(.plain)
            .focusable(false)
            .help("Copy full ID")
            .opacity(self.isHoveringDetail ? 1 : 0)
            Spacer()
            Text(PairingCardPresentation.metaLine(for: self.card))
                .font(.caption)
                .foregroundStyle(.tertiary)
                .help(PairingCardPresentation.versionTooltip(for: self.card))
        }
        .onHover { self.isHoveringDetail = $0 }
    }

    @ViewBuilder
    private var approveButton: some View {
        let button = Button {
            self.onDecision(.approve)
        } label: {
            Text(self.card.kind == .node ? "Approve Node" : "Approve Device")
                .padding(.horizontal, 6)
        }
        let shortcut: KeyboardShortcut? = self.isOnlyRequest ? .defaultAction : nil
        if #available(macOS 26.0, *) {
            button
                .buttonStyle(.glassProminent)
                .buttonBorderShape(.capsule)
                .keyboardShortcut(shortcut)
        } else {
            button
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.capsule)
                .keyboardShortcut(shortcut)
        }
    }

    @ViewBuilder
    private var rejectButton: some View {
        let button = Button(role: .destructive) {
            self.onDecision(.reject)
        } label: {
            Text("Reject")
                .padding(.horizontal, 6)
        }
        if #available(macOS 26.0, *) {
            button
                .buttonStyle(.glass)
                .buttonBorderShape(.capsule)
        } else {
            button
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
        }
    }
}

/// Pure display mapping for pairing cards; kept UI-framework-free so tests
/// can assert copy and symbols without instantiating views.
enum PairingCardPresentation {
    struct AccessRow: Identifiable, Equatable {
        /// Derived from the raw grant, not display text: distinct grants can
        /// render identically (e.g. caps `voice`/`audio`) and colliding ids
        /// would let SwiftUI drop rows from the approval surface.
        let id: String
        let symbol: String
        let text: String
        let isElevated: Bool
    }

    enum TrustTone: Equatable {
        case caution
        case neutral
    }

    struct TrustLine: Equatable {
        let symbol: String
        let text: String
        let tone: TrustTone
    }

    static func headerSummary(for cards: [PairingApprovalCenter.Card]) -> String {
        guard cards.count == 1, let card = cards.first else {
            return "\(cards.count) devices want to connect to OpenClaw."
        }
        return card.kind == .node
            ? "A node wants to connect to OpenClaw."
            : "A device wants to connect to OpenClaw."
    }

    static func title(for card: PairingApprovalCenter.Card) -> String {
        let name = card.displayName?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let name, !name.isEmpty, name != card.subjectId {
            return name
        }
        switch card.kind {
        case .node: return "Unnamed node"
        case .device: return self.isMac(card.platform) ? "OpenClaw Mac app" : "New device"
        }
    }

    static func subtitle(for card: PairingApprovalCenter.Card) -> String? {
        var parts: [String] = []
        if let platform = self.prettyPlatform(card.platform) {
            parts.append(platform)
        }
        if let model = self.prettyModel(card.modelIdentifier, deviceFamily: card.deviceFamily),
           parts.allSatisfy({ $0 != model })
        {
            parts.append(model)
        }
        if card.kind == .device, let role = card.role?.trimmingCharacters(in: .whitespacesAndNewlines),
           !role.isEmpty
        {
            parts.append(role == "operator" ? "Operator" : role)
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    static func trustLine(for card: PairingApprovalCenter.Card) -> TrustLine {
        if card.isRepair {
            return TrustLine(
                symbol: "arrow.triangle.2.circlepath",
                text: "Repair request — its access token will rotate",
                tone: .caution)
        }
        switch card.previouslyPaired {
        case true:
            // The requester merely CLAIMS this id (it is not authenticated),
            // so an already-paired id is a caution — approval replaces the
            // existing peer's token — never a positive trust signal.
            return TrustLine(
                symbol: "exclamationmark.triangle",
                text: "This ID is already paired — approving replaces its access token",
                tone: .caution)
        case false:
            return TrustLine(
                symbol: "sparkles",
                text: "First connection from this \(card.kind == .node ? "node" : "device")",
                tone: .neutral)
        case nil:
            return TrustLine(
                symbol: "clock",
                text: "Checking pairing history…",
                tone: .neutral)
        }
    }

    static func accessRows(for card: PairingApprovalCenter.Card) -> [AccessRow] {
        switch card.kind {
        case .device:
            // Admin access is what approval actually grants; surface it first
            // and highlighted so it can never hide among ordinary scopes.
            let rows = self.friendlyScopes(card.scopes).map { scope in
                AccessRow(
                    id: "scope:\(scope.raw)",
                    symbol: scope.raw == "operator.admin" ? "exclamationmark.shield" : "key",
                    text: scope.text,
                    isElevated: scope.raw == "operator.admin")
            }
            return rows.filter(\.isElevated) + rows.filter { !$0.isElevated }
        case .node:
            var rows: [AccessRow] = []
            // Commands in NODE_SYSTEM_RUN_COMMANDS (src/infra/node-commands.ts)
            // mean approving grants arbitrary command execution on the node.
            let isSystemRun = { (command: String) in
                command == "system.run" || command == "system.which" || command.hasPrefix("system.run.")
            }
            if card.commands.contains(where: isSystemRun) {
                rows.append(AccessRow(
                    id: "system-run",
                    symbol: "exclamationmark.shield",
                    text: "Can run system commands",
                    isElevated: true))
            }
            rows.append(contentsOf: self.friendlyCapNames(card.caps).map {
                AccessRow(id: "cap:\($0.raw)", symbol: $0.symbol, text: $0.text, isElevated: false)
            })
            // Approval persists the whole declared command surface; list the
            // remaining commands so none of it is granted invisibly.
            var seen = Set<String>()
            let otherCommands = card.commands.filter {
                !$0.isEmpty && !isSystemRun($0) && seen.insert($0).inserted
            }
            if !otherCommands.isEmpty {
                rows.append(AccessRow(
                    id: "commands",
                    symbol: "terminal",
                    text: "Commands: \(otherCommands.joined(separator: ", "))",
                    isElevated: false))
            }
            return rows
        }
    }

    /// Left, monospaced: stable identity facts (short id, source address).
    static func identityLine(for card: PairingApprovalCenter.Card) -> String {
        var parts = ["ID \(self.shortIdentifier(card.subjectId))"]
        if let ip = self.prettyIP(card.remoteIp) {
            parts.append(ip)
        }
        return parts.joined(separator: " · ")
    }

    /// Right, trailing: app version and request age.
    static func metaLine(for card: PairingApprovalCenter.Card, now: Date = Date()) -> String {
        var parts: [String] = []
        if let version = card.version?.trimmingCharacters(in: .whitespacesAndNewlines),
           !version.isEmpty
        {
            parts.append("v\(version)")
        }
        parts.append(self.relativeRequestTime(for: card, now: now))
        return parts.joined(separator: " · ")
    }

    static func versionTooltip(for card: PairingApprovalCenter.Card) -> String {
        var parts: [String] = []
        if let version = card.version?.trimmingCharacters(in: .whitespacesAndNewlines),
           !version.isEmpty
        {
            parts.append("App \(version)")
        }
        if let core = card.coreVersion?.trimmingCharacters(in: .whitespacesAndNewlines),
           !core.isEmpty
        {
            parts.append("Core \(core)")
        }
        return parts.joined(separator: " · ")
    }

    static func relativeRequestTime(for card: PairingApprovalCenter.Card, now: Date = Date()) -> String {
        let elapsed = now.timeIntervalSince(card.requestedAt)
        if elapsed < 60 {
            return "just now"
        }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter.localizedString(for: card.requestedAt, relativeTo: now)
    }

    static func deviceSymbol(for card: PairingApprovalCenter.Card) -> String {
        let model = card.modelIdentifier?.lowercased() ?? ""
        if model.hasPrefix("macbook") {
            return "macbook"
        }
        if model.hasPrefix("macmini") {
            return "macmini"
        }
        if model.hasPrefix("macstudio") {
            return "macstudio"
        }
        if model.hasPrefix("macpro") {
            return "macpro.gen3"
        }
        if model.hasPrefix("imac") {
            return "desktopcomputer"
        }

        let family = (card.deviceFamily ?? "").lowercased()
        let platform = (card.platform ?? "").lowercased()
        let hints = "\(family) \(platform)"
        if hints.contains("iphone") || hints.contains("ios") {
            return "iphone"
        }
        if hints.contains("ipad") {
            return "ipad"
        }
        if hints.contains("android") {
            return "smartphone"
        }
        if hints.contains("mac") || hints.contains("darwin") {
            return "laptopcomputer"
        }
        if hints.contains("linux") || hints.contains("windows") {
            return "server.rack"
        }
        return "network"
    }

    static func shortIdentifier(_ id: String) -> String {
        let trimmed = id.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count > 20 else {
            return trimmed
        }
        return "\(trimmed.prefix(8))...\(trimmed.suffix(7))"
    }

    static func prettyIP(_ ip: String?) -> String? {
        let trimmed = ip?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let trimmed, !trimmed.isEmpty else {
            return nil
        }
        return trimmed.replacingOccurrences(of: "::ffff:", with: "")
    }

    static func prettyPlatform(_ raw: String?) -> String? {
        let platform = raw?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let platform, !platform.isEmpty else {
            return nil
        }
        // Device pairing sends browser-style tokens (MacIntel); map those
        // before the generic "os version" formatter capitalizes them.
        switch platform.lowercased() {
        case "macintel", "x86_64-apple-darwin":
            return "Mac (Intel)"
        case "macarm", "macarm64", "arm64-apple-darwin", "aarch64-apple-darwin":
            return "Mac (Apple silicon)"
        case "darwin":
            return "Mac"
        default:
            if let pretty = PlatformLabelFormatter.pretty(platform) {
                return pretty
            }
            return platform.lowercased().contains("mac") ? "Mac" : platform
        }
    }

    static func friendlyScopes(_ scopes: [String]) -> [(raw: String, text: String)] {
        var seen = Set<String>()
        return scopes.compactMap { scope in
            let normalized = scope.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !normalized.isEmpty, seen.insert(normalized).inserted else {
                return nil
            }
            switch normalized {
            case "operator.admin":
                return (normalized, "Admin access")
            case "operator.read":
                return (normalized, "Read OpenClaw data")
            case "operator.write":
                return (normalized, "Send messages and make changes")
            case "operator.approvals":
                return (normalized, "Manage approvals")
            case "operator.pairing":
                return (normalized, "Pair and repair devices")
            case "operator.talk.secrets":
                return (normalized, "Use Talk credentials")
            default:
                return (normalized, normalized)
            }
        }
    }

    static func friendlyCapNames(_ caps: [String]) -> [(raw: String, symbol: String, text: String)] {
        var seen = Set<String>()
        return caps.compactMap { cap in
            let normalized = cap.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            guard !normalized.isEmpty, seen.insert(normalized).inserted else {
                return nil
            }
            switch normalized {
            case "screen":
                return (normalized, "rectangle.inset.filled.badge.record", "Screen capture")
            case "camera":
                return (normalized, "camera", "Camera")
            case "file":
                return (normalized, "folder", "File transfer")
            case "location":
                return (normalized, "location", "Location")
            case "voice", "audio":
                return (normalized, "mic", "Microphone and voice")
            case "canvas":
                return (normalized, "paintbrush", "Canvas display")
            default:
                return (normalized, "puzzlepiece.extension", self.prettifyRawName(normalized))
            }
        }
    }

    private static func prettifyRawName(_ raw: String) -> String {
        let words = raw.split(whereSeparator: { $0 == "-" || $0 == "_" || $0 == "." }).map(String.init)
        guard let first = words.first else {
            return raw
        }
        let capitalized = first.prefix(1).uppercased() + first.dropFirst()
        return ([capitalized] + words.dropFirst()).joined(separator: " ")
    }

    private static func prettyModel(_ modelIdentifier: String?, deviceFamily: String?) -> String? {
        let model = modelIdentifier?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let model, !model.isEmpty {
            return model
        }
        let family = deviceFamily?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let family, !family.isEmpty else {
            return nil
        }
        return family
    }

    private static func isMac(_ platform: String?) -> Bool {
        guard let platform else {
            return false
        }
        let lower = platform.lowercased()
        return lower.contains("mac") || lower.contains("darwin")
    }
}
