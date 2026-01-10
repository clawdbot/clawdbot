import SwiftUI

extension ConnectionsSettings {
    private func providerStatus<T: Decodable>(
        _ id: String,
        as type: T.Type) -> T?
    {
        self.store.snapshot?.decodeProvider(id, as: type)
    }

    var whatsAppTint: Color {
        guard let status = self.providerStatus("whatsapp", as: ProvidersStatusSnapshot.WhatsAppStatus.self)
        else { return .secondary }
        if !status.configured { return .secondary }
        if !status.linked { return .red }
        if status.lastError != nil { return .orange }
        if status.connected { return .green }
        if status.running { return .orange }
        return .orange
    }

    var telegramTint: Color {
        guard let status = self.providerStatus("telegram", as: ProvidersStatusSnapshot.TelegramStatus.self)
        else { return .secondary }
        if !status.configured { return .secondary }
        if status.lastError != nil { return .orange }
        if status.probe?.ok == false { return .orange }
        if status.running { return .green }
        return .orange
    }

    var discordTint: Color {
        guard let status = self.providerStatus("discord", as: ProvidersStatusSnapshot.DiscordStatus.self)
        else { return .secondary }
        if !status.configured { return .secondary }
        if status.lastError != nil { return .orange }
        if status.probe?.ok == false { return .orange }
        if status.running { return .green }
        return .orange
    }

    var signalTint: Color {
        guard let status = self.providerStatus("signal", as: ProvidersStatusSnapshot.SignalStatus.self)
        else { return .secondary }
        if !status.configured { return .secondary }
        if status.lastError != nil { return .orange }
        if status.probe?.ok == false { return .orange }
        if status.running { return .green }
        return .orange
    }

    var imessageTint: Color {
        guard let status = self.providerStatus("imessage", as: ProvidersStatusSnapshot.IMessageStatus.self)
        else { return .secondary }
        if !status.configured { return .secondary }
        if status.lastError != nil { return .orange }
        if status.probe?.ok == false { return .orange }
        if status.running { return .green }
        return .orange
    }

    var whatsAppSummary: String {
        guard let status = self.providerStatus("whatsapp", as: ProvidersStatusSnapshot.WhatsAppStatus.self)
        else { return "Checking…" }
        if !status.linked { return "Not linked" }
        if status.connected { return "Connected" }
        if status.running { return "Running" }
        return "Linked"
    }

    var telegramSummary: String {
        guard let status = self.providerStatus("telegram", as: ProvidersStatusSnapshot.TelegramStatus.self)
        else { return "Checking…" }
        if !status.configured { return "Not configured" }
        if status.running { return "Running" }
        return "Configured"
    }

    var discordSummary: String {
        guard let status = self.providerStatus("discord", as: ProvidersStatusSnapshot.DiscordStatus.self)
        else { return "Checking…" }
        if !status.configured { return "Not configured" }
        if status.running { return "Running" }
        return "Configured"
    }

    var signalSummary: String {
        guard let status = self.providerStatus("signal", as: ProvidersStatusSnapshot.SignalStatus.self)
        else { return "Checking…" }
        if !status.configured { return "Not configured" }
        if status.running { return "Running" }
        return "Configured"
    }

    var imessageSummary: String {
        guard let status = self.providerStatus("imessage", as: ProvidersStatusSnapshot.IMessageStatus.self)
        else { return "Checking…" }
        if !status.configured { return "Not configured" }
        if status.running { return "Running" }
        return "Configured"
    }

    var whatsAppDetails: String? {
        guard let status = self.providerStatus("whatsapp", as: ProvidersStatusSnapshot.WhatsAppStatus.self)
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
        guard let status = self.providerStatus("telegram", as: ProvidersStatusSnapshot.TelegramStatus.self)
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
        guard let status = self.providerStatus("discord", as: ProvidersStatusSnapshot.DiscordStatus.self)
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
        guard let status = self.providerStatus("signal", as: ProvidersStatusSnapshot.SignalStatus.self)
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
        guard let status = self.providerStatus("imessage", as: ProvidersStatusSnapshot.IMessageStatus.self)
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
        self.providerStatus("telegram", as: ProvidersStatusSnapshot.TelegramStatus.self)?.tokenSource == "env"
    }

    var isDiscordTokenLocked: Bool {
        self.providerStatus("discord", as: ProvidersStatusSnapshot.DiscordStatus.self)?.tokenSource == "env"
    }

    var orderedProviders: [ConnectionProvider] {
        ConnectionProvider.allCases.sorted { lhs, rhs in
            let lhsEnabled = self.providerEnabled(lhs)
            let rhsEnabled = self.providerEnabled(rhs)
            if lhsEnabled != rhsEnabled { return lhsEnabled && !rhsEnabled }
            return lhs.sortOrder < rhs.sortOrder
        }
    }

    var enabledProviders: [ConnectionProvider] {
        self.orderedProviders.filter { self.providerEnabled($0) }
    }

    var availableProviders: [ConnectionProvider] {
        self.orderedProviders.filter { !self.providerEnabled($0) }
    }

    func ensureSelection() {
        guard let selected = self.selectedProvider else {
            self.selectedProvider = self.orderedProviders.first
            return
        }
        if !self.orderedProviders.contains(selected) {
            self.selectedProvider = self.orderedProviders.first
        }
    }

    func providerEnabled(_ provider: ConnectionProvider) -> Bool {
        switch provider {
        case .whatsapp:
            guard let status = self.providerStatus("whatsapp", as: ProvidersStatusSnapshot.WhatsAppStatus.self)
            else { return false }
            return status.configured || status.linked || status.running
        case .telegram:
            guard let status = self.providerStatus("telegram", as: ProvidersStatusSnapshot.TelegramStatus.self)
            else { return false }
            return status.configured || status.running
        case .discord:
            guard let status = self.providerStatus("discord", as: ProvidersStatusSnapshot.DiscordStatus.self)
            else { return false }
            return status.configured || status.running
        case .signal:
            guard let status = self.providerStatus("signal", as: ProvidersStatusSnapshot.SignalStatus.self)
            else { return false }
            return status.configured || status.running
        case .imessage:
            guard let status = self.providerStatus("imessage", as: ProvidersStatusSnapshot.IMessageStatus.self)
            else { return false }
            return status.configured || status.running
        }
    }

    @ViewBuilder
    func providerSection(_ provider: ConnectionProvider) -> some View {
        switch provider {
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

    func providerTint(_ provider: ConnectionProvider) -> Color {
        switch provider {
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

    func providerSummary(_ provider: ConnectionProvider) -> String {
        switch provider {
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

    func providerDetails(_ provider: ConnectionProvider) -> String? {
        switch provider {
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

    func providerLastCheckText(_ provider: ConnectionProvider) -> String {
        guard let date = self.providerLastCheck(provider) else { return "never" }
        return relativeAge(from: date)
    }

    func providerLastCheck(_ provider: ConnectionProvider) -> Date? {
        switch provider {
        case .whatsapp:
            guard let status = self.providerStatus("whatsapp", as: ProvidersStatusSnapshot.WhatsAppStatus.self)
            else { return nil }
            return self.date(fromMs: status.lastEventAt ?? status.lastMessageAt ?? status.lastConnectedAt)
        case .telegram:
            return self
                .date(fromMs: self.providerStatus("telegram", as: ProvidersStatusSnapshot.TelegramStatus.self)?
                    .lastProbeAt)
        case .discord:
            return self
                .date(fromMs: self.providerStatus("discord", as: ProvidersStatusSnapshot.DiscordStatus.self)?
                    .lastProbeAt)
        case .signal:
            return self
                .date(fromMs: self.providerStatus("signal", as: ProvidersStatusSnapshot.SignalStatus.self)?.lastProbeAt)
        case .imessage:
            return self
                .date(fromMs: self.providerStatus("imessage", as: ProvidersStatusSnapshot.IMessageStatus.self)?
                    .lastProbeAt)
        }
    }

    func providerHasError(_ provider: ConnectionProvider) -> Bool {
        switch provider {
        case .whatsapp:
            guard let status = self.providerStatus("whatsapp", as: ProvidersStatusSnapshot.WhatsAppStatus.self)
            else { return false }
            return status.lastError?.isEmpty == false || status.lastDisconnect?.loggedOut == true
        case .telegram:
            guard let status = self.providerStatus("telegram", as: ProvidersStatusSnapshot.TelegramStatus.self)
            else { return false }
            return status.lastError?.isEmpty == false || status.probe?.ok == false
        case .discord:
            guard let status = self.providerStatus("discord", as: ProvidersStatusSnapshot.DiscordStatus.self)
            else { return false }
            return status.lastError?.isEmpty == false || status.probe?.ok == false
        case .signal:
            guard let status = self.providerStatus("signal", as: ProvidersStatusSnapshot.SignalStatus.self)
            else { return false }
            return status.lastError?.isEmpty == false || status.probe?.ok == false
        case .imessage:
            guard let status = self.providerStatus("imessage", as: ProvidersStatusSnapshot.IMessageStatus.self)
            else { return false }
            return status.lastError?.isEmpty == false || status.probe?.ok == false
        }
    }
}
