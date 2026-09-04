import AppKit
import SwiftUI

struct PairingApprovalPanelView: View {
    let center: PairingApprovalCenter

    var body: some View {
        let cards = self.center.cards
        VStack(spacing: 0) {
            HStack(spacing: 14) {
                if let icon = NSApp.applicationIconImage {
                    Image(nsImage: icon)
                        .resizable()
                        .interpolation(.high)
                        .frame(width: 64, height: 64)
                        .accessibilityHidden(true)
                }
                VStack(alignment: .leading, spacing: 5) {
                    Text("OpenClaw")
                        .font(.system(size: 13, weight: .semibold))
                    Text(verbatim: PairingCardPresentation.headerTitle(for: cards))
                        .font(.system(size: 23, weight: .semibold))
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 24)
            .padding(.vertical, 18)

            // Keep the entire requested grant surface visible; long queues scroll.
            ScrollView {
                VStack(spacing: 16) {
                    ForEach(cards) { card in
                        PairingRequestCardView(
                            card: card,
                            isOnlyRequest: cards.count == 1,
                            onDecision: { self.center.decide(card, $0) },
                            onSnooze: { self.center.snooze() })
                    }
                }
                .padding(.horizontal, 24)
                .padding(.bottom, 24)
            }
            .scrollBounceBehavior(.basedOnSize)

            if cards.count > 1 {
                Divider()
                HStack(spacing: 10) {
                    Button("Not Now") { self.center.snooze() }
                        .keyboardShortcut(.cancelAction)
                        .buttonStyle(.plain)
                        .foregroundStyle(.secondary)
                    Spacer()
                    // Bulk actions resolve the rendered snapshot, never newly arrived requests.
                    // They deliberately have no keyboard shortcut.
                    Button("Reject All") { self.center.decideAll(cards, .reject) }
                    Button("Approve All") { self.center.decideAll(cards, .approve) }
                        .buttonStyle(.borderedProminent)
                }
                .controlSize(.large)
                .padding(.horizontal, 24)
                .padding(.vertical, 16)
            }
        }
        .frame(width: PairingApprovalPanelController.panelWidth)
        .background(Color(nsColor: .windowBackgroundColor))
    }
}

struct PairingRequestCardView: View {
    let card: PairingApprovalCenter.Card
    let isOnlyRequest: Bool
    let onDecision: (PairingApprovalCenter.Decision) -> Void
    let onSnooze: () -> Void

    @State private var showingDetails = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: PairingCardPresentation.deviceSymbol(for: self.card))
                    .font(.system(size: 24))
                    .foregroundStyle(.secondary)
                    .frame(width: 40, height: 40)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 5) {
                    let title = PairingCardPresentation.title(for: self.card)
                    Text(verbatim: title)
                        .font(.system(size: 17, weight: .semibold))
                        .lineLimit(2)
                        .help(Text(verbatim: title))
                    if let subtitle = PairingCardPresentation.subtitle(for: self.card) {
                        Text(verbatim: subtitle)
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                }
                Spacer(minLength: 0)
                Button("Details") { self.showingDetails.toggle() }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .font(.system(size: 12))
                    .popover(isPresented: self.$showingDetails, arrowEdge: .bottom) { self.details }
            }

            if let warning = PairingCardPresentation.trustWarning(for: self.card) {
                Label(warning, systemImage: "exclamationmark.triangle")
                    .font(.system(size: 12))
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }

            self.accessRows
            Divider()

            HStack(spacing: 10) {
                if self.isOnlyRequest {
                    Button("Not Now", action: self.onSnooze)
                        .keyboardShortcut(.cancelAction)
                        .buttonStyle(.plain)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button("Reject") { self.onDecision(.reject) }
                Button {
                    self.onDecision(.approve)
                } label: {
                    Text(self.card.kind == .node ? "Approve Node" : "Approve Device")
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(self.isOnlyRequest ? KeyboardShortcut(.return, modifiers: .command) : nil)
                .help(self.isOnlyRequest ? "Approve this request (⌘Return)" : "Approve this request")
            }
            .controlSize(.large)
        }
        .padding(16)
        .background(Color(nsColor: .textBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.primary.opacity(0.1)))
    }

    private var accessRows: some View {
        let rows = PairingCardPresentation.accessRows(for: self.card)
        return VStack(alignment: .leading, spacing: 10) {
            Text("REQUESTED ACCESS")
                .font(.system(size: 10, weight: .semibold))
                .tracking(1.2)
                .foregroundStyle(.secondary)
            ForEach(rows.filter(\.isElevated)) { row in
                self.accessLabel(row)
                    .foregroundStyle(.orange)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                    .background(.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
            }
            LazyVGrid(
                columns: [GridItem(.flexible(), alignment: .leading), GridItem(.flexible(), alignment: .leading)],
                alignment: .leading,
                spacing: 6)
            {
                ForEach(rows.filter { !$0.isElevated && $0.id != "commands" }) { row in
                    self.accessLabel(row)
                }
            }
            // Unknown commands are still grants; show the complete list at full width.
            ForEach(rows.filter { $0.id == "commands" }) { row in
                self.accessLabel(row)
            }
            if rows.isEmpty {
                Text("No additional capabilities requested.")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func accessLabel(_ row: PairingCardPresentation.AccessRow) -> some View {
        Label(PairingCardPresentation.display(row.text), systemImage: row.symbol)
            .font(.system(size: 12))
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
    }

    private var details: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Request details").font(.headline)
                Spacer()
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(
                        PairingCardPresentation.display(self.card.subjectId),
                        forType: .string)
                } label: {
                    Label("Copy ID", systemImage: "doc.on.doc")
                }
                .buttonStyle(.plain)
            }
            ScrollView {
                Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 10) {
                    self.detail("ID", value: self.card.subjectId)
                    self.detail("Model", value: self.card.modelIdentifier)
                    self.detail("App version", value: self.card.version)
                    self.detail("Core version", value: self.card.coreVersion)
                    GridRow(alignment: .top) {
                        Text("Requested").foregroundStyle(.secondary)
                        Text(self.card.requestedAt, format: .dateTime.month(.abbreviated).day().year().hour().minute())
                            .textSelection(.enabled)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 220)
        }
        .font(.system(size: 12))
        .padding(16)
        .frame(width: 420)
    }

    @ViewBuilder
    private func detail(_ title: LocalizedStringKey, value: String?) -> some View {
        if let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            GridRow(alignment: .top) {
                Text(title).foregroundStyle(.secondary)
                Text(verbatim: PairingCardPresentation.display(value))
                    .fontDesign(.monospaced)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

enum PairingCardPresentation {
    struct AccessRow: Identifiable, Equatable {
        /// Single grants use their raw value; intentional grouped grants use a
        /// dedicated group id so SwiftUI never drops a rendered access row.
        let id: String
        let symbol: String
        let text: String
        let isElevated: Bool
    }

    static func headerTitle(for cards: [PairingApprovalCenter.Card]) -> String {
        guard cards.count == 1, let card = cards.first else {
            return String(localized: "Review pairing requests")
        }
        return card.kind == .node
            ? String(localized: "Allow this node’s capabilities?")
            : String(localized: "Allow this device?")
    }

    static func display(_ value: String) -> String {
        ExecApprovalCommandDisplaySanitizer.sanitize(value)
    }

    static func title(for card: PairingApprovalCenter.Card) -> String {
        let name = card.displayName?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let name, !name.isEmpty, name != card.subjectId {
            return self.display(name)
        }
        switch card.kind {
        case .node: return String(localized: "Unnamed node")
        case .device: return self.isMac(card.platform)
            ? String(localized: "OpenClaw Mac app") : String(localized: "New device")
        }
    }

    static func subtitle(for card: PairingApprovalCenter.Card) -> String? {
        var parts: [String] = []
        if let platform = self.prettyPlatform(card.platform) {
            parts.append(platform)
        }
        if card.kind == .device, let role = card.role?.trimmingCharacters(in: .whitespacesAndNewlines),
           !role.isEmpty
        {
            parts.append(role == "operator" ? String(localized: "Operator") : role)
        }
        if let ip = self.prettyIP(card.remoteIp) {
            parts.append(ip)
        }
        return parts.isEmpty ? nil : self.display(parts.joined(separator: " · "))
    }

    static func trustWarning(for card: PairingApprovalCenter.Card) -> String? {
        // Node requests change capabilities on an authenticated paired device;
        // only device pairing replaces the requested role's access token.
        if card.kind == .node {
            return card.previouslyPaired == true
                ? String(localized: "This node is requesting updated capabilities.") : nil
        }
        if card.isRepair {
            return String(localized: "Approving this repair replaces the device’s access token.")
        }
        if card.previouslyPaired == true {
            return String(localized: "This device ID is already paired. Approving replaces its access token.")
        }
        return nil
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
            let canRunCommands = card.commands.contains(where: isSystemRun)
            // Approval privilege belongs to Gateway. Its request-level fact
            // covers command families this client may not recognize yet.
            if canRunCommands || card.requiredApproveScopes?.contains("operator.admin") == true {
                rows.append(AccessRow(
                    id: "node-approval",
                    symbol: "exclamationmark.shield",
                    text: canRunCommands
                        ? String(localized: "Can run system commands")
                        : String(localized: "Requires administrator approval"),
                    isElevated: true))
            }
            rows.append(contentsOf: self.friendlyCapNames(card.caps).map {
                AccessRow(id: $0.id, symbol: $0.symbol, text: $0.text, isElevated: false)
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

    private static let sessionProviderByCapability = [
        "codex-app-server-threads": "Codex",
        "codex-cli-sessions": "Codex",
        "claude-sessions": "Claude",
        "opencode-sessions": "OpenCode",
        "pi-sessions": "Pi",
    ]

    static func friendlyCapNames(_ caps: [String]) -> [(id: String, symbol: String, text: String)] {
        var seen = Set<String>()
        let normalizedCaps = caps.compactMap { cap -> String? in
            let normalized = cap.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            guard !normalized.isEmpty, seen.insert(normalized).inserted else {
                return nil
            }
            return normalized
        }

        var seenSessionProviders = Set<String>()
        let sessionProviders = normalizedCaps.compactMap { capability -> String? in
            guard let provider = self.sessionProviderByCapability[capability],
                  seenSessionProviders.insert(provider).inserted
            else { return nil }
            return provider
        }
        var renderedSessionGroup = false

        return normalizedCaps.compactMap { normalized in
            if self.sessionProviderByCapability[normalized] != nil {
                guard !renderedSessionGroup else { return nil }
                renderedSessionGroup = true
                return (
                    "cap-group:sessions",
                    "rectangle.stack",
                    "Sessions: \(sessionProviders.joined(separator: ", "))")
            }
            switch normalized {
            case "screen":
                return ("cap:\(normalized)", "rectangle.inset.filled.badge.record", "Screen capture")
            case "camera":
                return ("cap:\(normalized)", "camera", "Camera")
            case "file":
                return ("cap:\(normalized)", "folder", "File transfer")
            case "location":
                return ("cap:\(normalized)", "location", "Location")
            case "voice", "audio":
                return ("cap:\(normalized)", "mic", "Microphone and voice")
            case "canvas":
                return ("cap:\(normalized)", "paintbrush", "Canvas display")
            default:
                return ("cap:\(normalized)", "puzzlepiece.extension", self.prettifyRawName(normalized))
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

    private static func isMac(_ platform: String?) -> Bool {
        guard let platform else {
            return false
        }
        let lower = platform.lowercased()
        return lower.contains("mac") || lower.contains("darwin")
    }
}
