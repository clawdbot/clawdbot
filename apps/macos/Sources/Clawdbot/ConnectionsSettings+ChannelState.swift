import SwiftUI

extension ConnectionsSettings {
    private func channelStatus<T: Decodable>(
        _ id: String,
        as type: T.Type) -> T?
    {
        self.store.snapshot?.decodeChannel(id, as: type)
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
        if !status.configured { return .secondary }
        if status.lastError != nil { return .orange }
        if status.probe?.ok == false { return .orange }
        if status.running { return .green }
        return .orange
    }

    var discordTint: Color {
        guard let status = self.channelStatus("discord", as: ChannelsStatusSnapshot.DiscordStatus.self)
        else { return .secondary }
        if !status.configured { return .secondary }
        if status.lastError != nil { return .orange }
        if status.probe?.ok == false { return .orange }
        if status.running { return .green }
        return .orange
    }

    var signalTint: Color {
        guard let status = self.channelStatus("signal", as: ChannelsStatusSnapshot.SignalStatus.self)
        else { return .secondary }
        if !status.configured { return .secondary }
        if status.lastError != nil { return .orange }
        if status.probe?.ok == false { return .orange }
        if status.running { return .green }
        return .orange
    }

    var imessageTint: Color {
        guard let status = self.channelStatus("imessage", as: ChannelsStatusSnapshot.IMessageStatus.self)
        else { return .secondary }
        if !status.configured { return .secondary }
        if status.lastError != nil { return .orange }
        if status.probe?.ok == false { return .orange }
        if status.running { return .green }
        return .orange
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
        if !status.configured { return "Not configured" }
        if status.running { return "Running" }
        return "Configured"
    }

    var discordSummary: String {
        guard let status = self.channelStatus("discord", as: ChannelsStatusSnapshot.DiscordStatus.self)
        else { return "Checking…" }
        if !status.configured { return "Not configured" }
        if status.running { return "Running" }
        return "Configured"
    }

    var signalSummary: String {
        guard let status = self.channelStatus("signal", as: ChannelsStatusSnapshot.SignalStatus.self)
        else { return "Checking…" }
        if !status.configured { return "Not configured" }
        if status.running { return "Running" }
        return "Configured"
    }

    var imessageSummary: String {
        guard let status = self.channelStatus("imessage", as: ChannelsStatusSnapshot.IMessageStatus.self)
        else { return "Checking…" }
        if !status.configured { return "Not configured" }
        if status.running { return "Running" }
        return "Configured"
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
            } else {
                let code = probe.status.map { String($0) } ?? "unknown"
                lines.append("Probe failed (\(code))")
            }
        }
        if let last = self.date(fromMs: status.lastProbeAt) {
            lines.append("Last probe \(relativeAge(from: last))")
        }
        if let err = status.lastError, !err.isEmpty {
            lines.append("Error: \(err)")
        }
        return lines.isEmpty ? nil : lines.joined(separator: " · ")
    }

    var discordDetails: String? {
        guard let status = self.channelStatus("discord", as: ChannelsStatusSnapshot.DiscordStatus.self)
        else { return nil }
        var lines: [String] = []
        if let source = status.tokenSource {
            lines.append("Token source: \(source)")
        }
        if let probe = status.probe {
            if probe.ok {
                if let name = probe.bot?.username {
                    lines.append("Bot: @\(name)")
                }
                if let elapsed = probe.elapsedMs {
                    lines.append("Probe \(Int(elapsed))ms")
                }
            } else {
                let code = probe.status.map { String($0) } ?? "unknown"
                lines.append("Probe failed (\(code))")
            }
        }
        if let last = self.date(fromMs: status.lastProbeAt) {
            lines.append("Last probe \(relativeAge(from: last))")
        }
        if let err = status.lastError, !err.isEmpty {
            lines.append("Error: \(err)")
        }
        return lines.isEmpty ? nil : lines.joined(separator: " · ")
    }

    var signalDetails: String? {
        guard let status = self.channelStatus("signal", as: ChannelsStatusSnapshot.SignalStatus.self)
        else { return nil }
        var lines: [String] = []
        lines.append("Base URL: \(status.baseUrl)")
        if let probe = status.probe {
            if probe.ok {
                if let version = probe.version, !version.isEmpty {
                    lines.append("Version \(version)")
                }
                if let elapsed = probe.elapsedMs {
                    lines.append("Probe \(Int(elapsed))ms")
                }
            } else {
                let code = probe.status.map { String($0) } ?? "unknown"
                lines.append("Probe failed (\(code))")
            }
        }
        if let last = self.date(fromMs: status.lastProbeAt) {
            lines.append("Last probe \(relativeAge(from: last))")
        }
        if let err = status.lastError, !err.isEmpty {
            lines.append("Error: \(err)")
        }
        return lines.isEmpty ? nil : lines.joined(separator: " · ")
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
        if let probe = status.probe, !probe.ok {
            let err = probe.error ?? "probe failed"
            lines.append("Probe error: \(err)")
        }
        if let last = self.date(fromMs: status.lastProbeAt) {
            lines.append("Last probe \(relativeAge(from: last))")
        }
        if let err = status.lastError, !err.isEmpty {
            lines.append("Error: \(err)")
        }
        return lines.isEmpty ? nil : lines.joined(separator: " · ")
    }

    var isTelegramTokenLocked: Bool {
        self.channelStatus("telegram", as: ChannelsStatusSnapshot.TelegramStatus.self)?.tokenSource == "env"
    }

    var isDiscordTokenLocked: Bool {
        self.channelStatus("discord", as: ChannelsStatusSnapshot.DiscordStatus.self)?.tokenSource == "env"
    }

    var orderedChannels: [ConnectionChannel] {
        ConnectionChannel.allCases.sorted { lhs, rhs in
            let lhsEnabled = self.channelEnabled(lhs)
            let rhsEnabled = self.channelEnabled(rhs)
            if lhsEnabled != rhsEnabled { return lhsEnabled && !rhsEnabled }
            return lhs.sortOrder < rhs.sortOrder
        }
    }

    var enabledChannels: [ConnectionChannel] {
        self.orderedChannels.filter { self.channelEnabled($0) }
    }

    var availableChannels: [ConnectionChannel] {
        self.orderedChannels.filter { !self.channelEnabled($0) }
    }

    func ensureSelection() {
        guard let selected = self.selectedChannel else {
            self.selectedChannel = self.orderedChannels.first
            return
        }
        if !self.orderedChannels.contains(selected) {
            self.selectedChannel = self.orderedChannels.first
        }
    }

    func channelEnabled(_ channel: ConnectionChannel) -> Bool {
        switch channel {
        case .whatsapp:
            guard let status = self.channelStatus("whatsapp", as: ChannelsStatusSnapshot.WhatsAppStatus.self)
            else { return false }
            return status.configured || status.linked || status.running
        case .telegram:
            guard let status = self.channelStatus("telegram", as: ChannelsStatusSnapshot.TelegramStatus.self)
            else { return false }
            return status.configured || status.running
        case .discord:
            guard let status = self.channelStatus("discord", as: ChannelsStatusSnapshot.DiscordStatus.self)
            else { return false }
            return status.configured || status.running
        case .signal:
            guard let status = self.channelStatus("signal", as: ChannelsStatusSnapshot.SignalStatus.self)
            else { return false }
            return status.configured || status.running
        case .imessage:
            guard let status = self.channelStatus("imessage", as: ChannelsStatusSnapshot.IMessageStatus.self)
            else { return false }
            return status.configured || status.running
        }
    }

    @ViewBuilder
    func channelSection(_ channel: ConnectionChannel) -> some View {
        switch channel {
        case .whatsapp:
            self.whatsAppSection
        case .telegram:
            self.telegramSection
        case .discord:
            self.discordSection
        case .signal:
            self.signalSection
        case .imessage:
            self.imessageSection
        }
    }

    func channelTint(_ channel: ConnectionChannel) -> Color {
        switch channel {
        case .whatsapp:
            self.whatsAppTint
        case .telegram:
            self.telegramTint
        case .discord:
            self.discordTint
        case .signal:
            self.signalTint
        case .imessage:
            self.imessageTint
        }
    }

    func channelSummary(_ channel: ConnectionChannel) -> String {
        switch channel {
        case .whatsapp:
            self.whatsAppSummary
        case .telegram:
            self.telegramSummary
        case .discord:
            self.discordSummary
        case .signal:
            self.signalSummary
        case .imessage:
            self.imessageSummary
        }
    }

    func channelDetails(_ channel: ConnectionChannel) -> String? {
        switch channel {
        case .whatsapp:
            self.whatsAppDetails
        case .telegram:
            self.telegramDetails
        case .discord:
            self.discordDetails
        case .signal:
            self.signalDetails
        case .imessage:
            self.imessageDetails
        }
    }

    func channelLastCheckText(_ channel: ConnectionChannel) -> String {
        guard let date = self.channelLastCheck(channel) else { return "never" }
        return relativeAge(from: date)
    }

    func channelLastCheck(_ channel: ConnectionChannel) -> Date? {
        switch channel {
        case .whatsapp:
            guard let status = self.channelStatus("whatsapp", as: ChannelsStatusSnapshot.WhatsAppStatus.self)
            else { return nil }
            return self.date(fromMs: status.lastEventAt ?? status.lastMessageAt ?? status.lastConnectedAt)
        case .telegram:
            return self
                .date(fromMs: self.channelStatus("telegram", as: ChannelsStatusSnapshot.TelegramStatus.self)?
                    .lastProbeAt)
        case .discord:
            return self
                .date(fromMs: self.channelStatus("discord", as: ChannelsStatusSnapshot.DiscordStatus.self)?
                    .lastProbeAt)
        case .signal:
            return self
                .date(fromMs: self.channelStatus("signal", as: ChannelsStatusSnapshot.SignalStatus.self)?.lastProbeAt)
        case .imessage:
            return self
                .date(fromMs: self.channelStatus("imessage", as: ChannelsStatusSnapshot.IMessageStatus.self)?
                    .lastProbeAt)
        }
    }

    func channelHasError(_ channel: ConnectionChannel) -> Bool {
        switch channel {
        case .whatsapp:
            guard let status = self.channelStatus("whatsapp", as: ChannelsStatusSnapshot.WhatsAppStatus.self)
            else { return false }
            return status.lastError?.isEmpty == false || status.lastDisconnect?.loggedOut == true
        case .telegram:
            guard let status = self.channelStatus("telegram", as: ChannelsStatusSnapshot.TelegramStatus.self)
            else { return false }
            return status.lastError?.isEmpty == false || status.probe?.ok == false
        case .discord:
            guard let status = self.channelStatus("discord", as: ChannelsStatusSnapshot.DiscordStatus.self)
            else { return false }
            return status.lastError?.isEmpty == false || status.probe?.ok == false
        case .signal:
            guard let status = self.channelStatus("signal", as: ChannelsStatusSnapshot.SignalStatus.self)
            else { return false }
            return status.lastError?.isEmpty == false || status.probe?.ok == false
        case .imessage:
            guard let status = self.channelStatus("imessage", as: ChannelsStatusSnapshot.IMessageStatus.self)
            else { return false }
            return status.lastError?.isEmpty == false || status.probe?.ok == false
        }
    }
}
