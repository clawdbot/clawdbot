import OpenClawProtocol
import SwiftUI

extension ChannelsSettings {
    private func channelStatus<T: Decodable>(
        _ id: String,
        as type: T.Type) -> T?
    {
        self.store.decodedChannel(id, as: type)
    }

    private func configuredChannelTint(configured: Bool, running: Bool, hasError: Bool, probeOk: Bool?) -> Color {
        if !configured { return .secondary }
        if hasError { return .orange }
        if probeOk == false { return .orange }
        if running { return .green }
        return .orange
    }

    private func configuredChannelSummary(configured: Bool, running: Bool) -> String {
        if !configured { return "Not configured" }
        if running { return "Running" }
        return "Configured"
    }

    private func appendProbeDetails(
        lines: inout [String],
        probeOk: Bool?,
        probeStatus: Int?,
        probeElapsedMs: Double?,
        probeVersion: String? = nil,
        probeError: String? = nil,
        lastProbeAtMs: Double?,
        lastError: String?)
    {
        if let probeOk {
            if probeOk {
                if let version = probeVersion, !version.isEmpty {
                    lines.append("Version \(version)")
                }
                if let elapsed = probeElapsedMs {
                    lines.append("Probe \(Int(elapsed))ms")
                }
            } else if let probeError, !probeError.isEmpty {
                lines.append("Probe error: \(probeError)")
            } else {
                let code = probeStatus.map { String($0) } ?? "unknown"
                lines.append("Probe failed (\(code))")
            }
        }
        if let last = self.date(fromMs: lastProbeAtMs) {
            lines.append("Last probe \(relativeAge(from: last))")
        }
        if let lastError, !lastError.isEmpty {
            lines.append("Error: \(lastError)")
        }
    }

    private func finishDetails(
        lines: inout [String],
        probeOk: Bool?,
        probeStatus: Int?,
        probeElapsedMs: Double?,
        probeVersion: String? = nil,
        probeError: String? = nil,
        lastProbeAtMs: Double?,
        lastError: String?) -> String?
    {
        self.appendProbeDetails(
            lines: &lines,
            probeOk: probeOk,
            probeStatus: probeStatus,
            probeElapsedMs: probeElapsedMs,
            probeVersion: probeVersion,
            probeError: probeError,
            lastProbeAtMs: lastProbeAtMs,
            lastError: lastError)
        return lines.isEmpty ? nil : lines.joined(separator: " · ")
    }

    private func finishProbeDetails(
        lines: inout [String],
        probe: (ok: Bool?, status: Int?, elapsedMs: Double?),
        lastProbeAtMs: Double?,
        lastError: String?) -> String?
    {
        self.finishDetails(
            lines: &lines,
            probeOk: probe.ok,
            probeStatus: probe.status,
            probeElapsedMs: probe.elapsedMs,
            lastProbeAtMs: lastProbeAtMs,
            lastError: lastError)
    }

    var whatsAppTint: Color {
        guard let status = self.channelStatus("whatsapp", as: ChannelsStatusSnapshot.WhatsAppStatus.self)
        else { return .secondary }
        if !status.configured { return .secondary }
        if !status.linked { return .red }
        if status.lastError != nil { return .orange }
        if status.connected { return .green }
        if status.running { return .orange }
        return .orange
    }

    var telegramTint: Color {
        guard let status = self.channelStatus("telegram", as: ChannelsStatusSnapshot.TelegramStatus.self)
        else { return .secondary }
        return self.configuredChannelTint(
            configured: status.configured,
            running: status.running,
            hasError: status.lastError != nil,
            probeOk: status.probe?.ok)
    }

    var discordTint: Color {
        guard let status = self.channelStatus("discord", as: ChannelsStatusSnapshot.DiscordStatus.self)
        else { return .secondary }
        return self.configuredChannelTint(
            configured: status.configured,
            running: status.running,
            hasError: status.lastError != nil,
            probeOk: status.probe?.ok)
    }

    var googlechatTint: Color {
        guard let status = self.channelStatus("googlechat", as: ChannelsStatusSnapshot.GoogleChatStatus.self)
        else { return .secondary }
        return self.configuredChannelTint(
            configured: status.configured,
            running: status.running,
            hasError: status.lastError != nil,
            probeOk: status.probe?.ok)
    }

    var signalTint: Color {
        guard let status = self.channelStatus("signal", as: ChannelsStatusSnapshot.SignalStatus.self)
        else { return .secondary }
        return self.configuredChannelTint(
            configured: status.configured,
            running: status.running,
            hasError: status.lastError != nil,
            probeOk: status.probe?.ok)
    }

    var imessageTint: Color {
        guard let status = self.channelStatus("imessage", as: ChannelsStatusSnapshot.IMessageStatus.self)
        else { return .secondary }
        return self.configuredChannelTint(
            configured: status.configured,
            running: status.running,
            hasError: status.lastError != nil,
            probeOk: status.probe?.ok)
    }

    var whatsAppSummary: String {
        guard let status = self.channelStatus("whatsapp", as: ChannelsStatusSnapshot.WhatsAppStatus.self)
        else { return "Checking…" }
        if !status.linked { return "Not linked" }
        if status.connected { return "Connected" }
        if status.running { return "Running" }
        return "Linked"
    }

    var telegramSummary: String {
        guard let status = self.channelStatus("telegram", as: ChannelsStatusSnapshot.TelegramStatus.self)
        else { return "Checking…" }
        return self.configuredChannelSummary(configured: status.configured, running: status.running)
    }

    var discordSummary: String {
        guard let status = self.channelStatus("discord", as: ChannelsStatusSnapshot.DiscordStatus.self)
        else { return "Checking…" }
        return self.configuredChannelSummary(configured: status.configured, running: status.running)
    }

    var googlechatSummary: String {
        guard let status = self.channelStatus("googlechat", as: ChannelsStatusSnapshot.GoogleChatStatus.self)
        else { return "Checking…" }
        return self.configuredChannelSummary(configured: status.configured, running: status.running)
    }

    var signalSummary: String {
        guard let status = self.channelStatus("signal", as: ChannelsStatusSnapshot.SignalStatus.self)
        else { return "Checking…" }
        return self.configuredChannelSummary(configured: status.configured, running: status.running)
    }

    var imessageSummary: String {
        guard let status = self.channelStatus("imessage", as: ChannelsStatusSnapshot.IMessageStatus.self)
        else { return "Checking…" }
        return self.configuredChannelSummary(configured: status.configured, running: status.running)
    }

    var whatsAppDetails: String? {
        guard let status = self.channelStatus("whatsapp", as: ChannelsStatusSnapshot.WhatsAppStatus.self)
        else { return nil }
        var lines: [String] = []
        if let e164 = status.`self`?.e164 ?? status.`self`?.jid {
            lines.append("Linked as \(e164)")
        }
        if let age = status.authAgeMs {
            lines.append("Auth age \(msToAge(age))")
        }
        if let last = self.date(fromMs: status.lastConnectedAt) {
            lines.append("Last connect \(relativeAge(from: last))")
        }
        if let disconnect = status.lastDisconnect {
            let when = self.date(fromMs: disconnect.at).map { relativeAge(from: $0) } ?? "unknown"
            let code = disconnect.status.map { "status \($0)" } ?? "status unknown"
            let err = disconnect.error ?? "disconnect"
            lines.append("Last disconnect \(code) · \(err) · \(when)")
        }
        if status.reconnectAttempts > 0 {
            lines.append("Reconnect attempts \(status.reconnectAttempts)")
        }
        if let msgAt = self.date(fromMs: status.lastMessageAt) {
            lines.append("Last message \(relativeAge(from: msgAt))")
        }
        if let err = status.lastError, !err.isEmpty {
            lines.append("Error: \(err)")
        }
        return lines.isEmpty ? nil : lines.joined(separator: " · ")
    }

    var telegramDetails: String? {
        guard let status = self.channelStatus("telegram", as: ChannelsStatusSnapshot.TelegramStatus.self)
        else { return nil }
        var lines: [String] = []
        if let source = status.tokenSource {
            lines.append("Token source: \(source)")
        }
        if let mode = status.mode {
            lines.append("Mode: \(mode)")
        }
        if let probe = status.probe {
            if probe.ok {
                if let name = probe.bot?.username {
                    lines.append("Bot: @\(name)")
                }
                if let url = probe.webhook?.url, !url.isEmpty {
                    lines.append("Webhook: \(url)")
                }
            }
        }
        return self.finishDetails(
            lines: &lines,
            probeOk: status.probe?.ok,
            probeStatus: status.probe?.status,
            probeElapsedMs: nil,
            lastProbeAtMs: status.lastProbeAt,
            lastError: status.lastError)
    }

    var discordDetails: String? {
        guard let status = self.channelStatus("discord", as: ChannelsStatusSnapshot.DiscordStatus.self)
        else { return nil }
        var lines: [String] = []
        if let source = status.tokenSource {
            lines.append("Token source: \(source)")
        }
        if let name = status.probe?.bot?.username, !name.isEmpty {
            lines.append("Bot: @\(name)")
        }
        return self.finishProbeDetails(
            lines: &lines,
            probe: (
                ok: status.probe?.ok,
                status: status.probe?.status,
                elapsedMs: status.probe?.elapsedMs),
            lastProbeAtMs: status.lastProbeAt,
            lastError: status.lastError)
    }

    var googlechatDetails: String? {
        guard let status = self.channelStatus("googlechat", as: ChannelsStatusSnapshot.GoogleChatStatus.self)
        else { return nil }
        var lines: [String] = []
        if let source = status.credentialSource {
            lines.append("Credential: \(source)")
        }
        if let audienceType = status.audienceType {
            let audience = status.audience ?? ""
            let label = audience.isEmpty ? audienceType : "\(audienceType) \(audience)"
            lines.append("Audience: \(label)")
        }
        return self.finishProbeDetails(
            lines: &lines,
            probe: (
                ok: status.probe?.ok,
                status: status.probe?.status,
                elapsedMs: status.probe?.elapsedMs),
            lastProbeAtMs: status.lastProbeAt,
            lastError: status.lastError)
    }

    var signalDetails: String? {
        guard let status = self.channelStatus("signal", as: ChannelsStatusSnapshot.SignalStatus.self)
        else { return nil }
        var lines: [String] = []
        lines.append("Base URL: \(status.baseUrl)")
        return self.finishDetails(
            lines: &lines,
            probeOk: status.probe?.ok,
            probeStatus: status.probe?.status,
            probeElapsedMs: status.probe?.elapsedMs,
            probeVersion: status.probe?.version,
            lastProbeAtMs: status.lastProbeAt,
            lastError: status.lastError)
    }

    var imessageDetails: String? {
        guard let status = self.channelStatus("imessage", as: ChannelsStatusSnapshot.IMessageStatus.self)
        else { return nil }
        var lines: [String] = []
        if let cliPath = status.cliPath, !cliPath.isEmpty {
            lines.append("CLI: \(cliPath)")
        }
        if let dbPath = status.dbPath, !dbPath.isEmpty {
            lines.append("DB: \(dbPath)")
        }
        return self.finishDetails(
            lines: &lines,
            probeOk: status.probe?.ok,
            probeStatus: nil,
            probeElapsedMs: nil,
            probeError: status.probe?.error,
            lastProbeAtMs: status.lastProbeAt,
            lastError: status.lastError)
    }

    var orderedChannels: [ChannelItem] {
        let fallback = ["whatsapp", "telegram", "discord", "googlechat", "slack", "signal", "imessage"]
        let order = self.store.snapshot?.channelOrder ?? fallback
        let channels = order.enumerated().map { index, id in
            ChannelItem(
                id: id,
                title: self.resolveChannelTitle(id),
                detailTitle: self.resolveChannelDetailTitle(id),
                systemImage: self.resolveChannelSystemImage(id),
                sortOrder: index)
        }
        return channels.sorted { lhs, rhs in
            let lhsEnabled = self.channelEnabled(lhs)
            let rhsEnabled = self.channelEnabled(rhs)
            if lhsEnabled != rhsEnabled { return lhsEnabled && !rhsEnabled }
            return lhs.sortOrder < rhs.sortOrder
        }
    }

    var enabledChannels: [ChannelItem] {
        self.orderedChannels.filter { self.channelEnabled($0) }
    }

    var availableChannels: [ChannelItem] {
        self.orderedChannels.filter { !self.channelEnabled($0) }
    }

    func ensureSelection() {
        self.ensureSelection(in: self.orderedChannels)
    }

    func ensureSelection(in orderedChannels: [ChannelItem]) {
        guard let selected = self.selectedChannel else {
            self.selectedChannel = orderedChannels.first
            return
        }
        if !orderedChannels.contains(selected) {
            self.selectedChannel = orderedChannels.first
        }
    }

    func channelEnabled(_ channel: ChannelItem) -> Bool {
        let status = self.channelStatusDictionary(channel.id)
        let configured = status?["configured"]?.boolValue ?? false
        let running = status?["running"]?.boolValue ?? false
        let connected = status?["connected"]?.boolValue ?? false
        let accountActive = self.store.snapshot?.channelAccounts[channel.id]?.contains(
            where: { $0.configured == true || $0.running == true || $0.connected == true }) ?? false
        return configured || running || connected || accountActive
    }

    @ViewBuilder
    func channelSection(_ channel: ChannelItem) -> some View {
        if channel.id == "whatsapp" {
            self.whatsAppSection
        } else {
            self.genericChannelSection(channel)
        }
    }

    func channelTint(_ channel: ChannelItem) -> Color {
        switch channel.id {
        case "whatsapp":
            return self.whatsAppTint
        case "telegram":
            return self.telegramTint
        case "discord":
            return self.discordTint
        case "googlechat":
            return self.googlechatTint
        case "signal":
            return self.signalTint
        case "imessage":
            return self.imessageTint
        default:
            if self.channelHasError(channel) { return .orange }
            if self.channelEnabled(channel) { return .green }
            return .secondary
        }
    }

    func channelSummary(_ channel: ChannelItem) -> String {
        switch channel.id {
        case "whatsapp":
            return self.whatsAppSummary
        case "telegram":
            return self.telegramSummary
        case "discord":
            return self.discordSummary
        case "googlechat":
            return self.googlechatSummary
        case "signal":
            return self.signalSummary
        case "imessage":
            return self.imessageSummary
        default:
            if self.channelHasError(channel) { return "Error" }
            if self.channelEnabled(channel) { return "Active" }
            return "Not configured"
        }
    }

    func channelDetails(_ channel: ChannelItem) -> String? {
        switch channel.id {
        case "whatsapp":
            return self.whatsAppDetails
        case "telegram":
            return self.telegramDetails
        case "discord":
            return self.discordDetails
        case "googlechat":
            return self.googlechatDetails
        case "signal":
            return self.signalDetails
        case "imessage":
            return self.imessageDetails
        default:
            let status = self.channelStatusDictionary(channel.id)
            if let err = status?["lastError"]?.stringValue, !err.isEmpty {
                return "Error: \(err)"
            }
            return nil
        }
    }

    func channelLastCheckText(_ channel: ChannelItem) -> String {
        guard let date = self.channelLastCheck(channel) else { return "never" }
        return relativeAge(from: date)
    }

    func channelLastCheck(_ channel: ChannelItem) -> Date? {
        switch channel.id {
        case "whatsapp":
            guard let status = self.channelStatus("whatsapp", as: ChannelsStatusSnapshot.WhatsAppStatus.self)
            else { return nil }
            return self.date(fromMs: status.lastEventAt ?? status.lastMessageAt ?? status.lastConnectedAt)
        case "telegram":
            return self
                .date(fromMs: self.channelStatus("telegram", as: ChannelsStatusSnapshot.TelegramStatus.self)?
                    .lastProbeAt)
        case "discord":
            return self
                .date(fromMs: self.channelStatus("discord", as: ChannelsStatusSnapshot.DiscordStatus.self)?
                    .lastProbeAt)
        case "googlechat":
            return self
                .date(fromMs: self.channelStatus("googlechat", as: ChannelsStatusSnapshot.GoogleChatStatus.self)?
                    .lastProbeAt)
        case "signal":
            return self
                .date(fromMs: self.channelStatus("signal", as: ChannelsStatusSnapshot.SignalStatus.self)?.lastProbeAt)
        case "imessage":
            return self
                .date(fromMs: self.channelStatus("imessage", as: ChannelsStatusSnapshot.IMessageStatus.self)?
                    .lastProbeAt)
        default:
            let status = self.channelStatusDictionary(channel.id)
            if let probeAt = status?["lastProbeAt"]?.doubleValue {
                return self.date(fromMs: probeAt)
            }
            if let accounts = self.store.snapshot?.channelAccounts[channel.id] {
                let last = accounts.compactMap { $0.lastInboundAt ?? $0.lastOutboundAt }.max()
                return self.date(fromMs: last)
            }
            return nil
        }
    }

    func channelHasError(_ channel: ChannelItem) -> Bool {
        switch channel.id {
        case "whatsapp":
            guard let status = self.channelStatus("whatsapp", as: ChannelsStatusSnapshot.WhatsAppStatus.self)
            else { return false }
            return status.lastError?.isEmpty == false || status.lastDisconnect?.loggedOut == true
        case "telegram":
            guard let status = self.channelStatus("telegram", as: ChannelsStatusSnapshot.TelegramStatus.self)
            else { return false }
            return status.lastError?.isEmpty == false || status.probe?.ok == false
        case "discord":
            guard let status = self.channelStatus("discord", as: ChannelsStatusSnapshot.DiscordStatus.self)
            else { return false }
            return status.lastError?.isEmpty == false || status.probe?.ok == false
        case "googlechat":
            guard let status = self.channelStatus("googlechat", as: ChannelsStatusSnapshot.GoogleChatStatus.self)
            else { return false }
            return status.lastError?.isEmpty == false || status.probe?.ok == false
        case "signal":
            guard let status = self.channelStatus("signal", as: ChannelsStatusSnapshot.SignalStatus.self)
            else { return false }
            return status.lastError?.isEmpty == false || status.probe?.ok == false
        case "imessage":
            guard let status = self.channelStatus("imessage", as: ChannelsStatusSnapshot.IMessageStatus.self)
            else { return false }
            return status.lastError?.isEmpty == false || status.probe?.ok == false
        default:
            let status = self.channelStatusDictionary(channel.id)
            return status?["lastError"]?.stringValue?.isEmpty == false
        }
    }

    private func resolveChannelTitle(_ id: String) -> String {
        let label = self.store.resolveChannelLabel(id)
        if label != id { return label }
        return id.prefix(1).uppercased() + id.dropFirst()
    }

    private func resolveChannelDetailTitle(_ id: String) -> String {
        self.store.resolveChannelDetailLabel(id)
    }

    private func resolveChannelSystemImage(_ id: String) -> String {
        self.store.resolveChannelSystemImage(id)
    }

    private func channelStatusDictionary(_ id: String) -> [String: AnyCodable]? {
        self.store.snapshot?.channels[id]?.dictionaryValue
    }
}
