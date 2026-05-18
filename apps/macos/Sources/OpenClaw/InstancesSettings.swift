import AppKit
import SwiftUI

struct InstancesSettings: View {
    var store: InstancesStore
    let isActive: Bool

    init(store: InstancesStore = .shared, isActive: Bool = true) {
        self.store = store
        self.isActive = isActive
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            self.header
            if let err = store.lastError {
                Text("Error: \(err)")
                    .foregroundStyle(.red)
            } else if let info = store.statusMessage {
                Text(info)
                    .foregroundStyle(.secondary)
            }
            if self.store.instances.isEmpty {
                Text("No instances reported yet.")
                    .foregroundStyle(.secondary)
            } else {
                List(self.store.instances) { inst in
                    self.instanceRow(inst)
                }
                .listStyle(.inset)
            }
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(.leading, 18)
        .padding(.trailing, SettingsLayout.scrollbarGutter)
        .onAppear { self.updateActiveWork(active: self.isActive) }
        .onChange(of: self.isActive) { _, active in
            self.updateActiveWork(active: active)
        }
        .onDisappear { self.store.stop() }
    }

    private func updateActiveWork(active: Bool) {
        if active {
            self.store.start()
        } else {
            self.store.stop()
        }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 16) {
            VStack(alignment: .leading, spacing: 5) {
                Text("Connected Instances")
                    .font(.title3.weight(.semibold))
                Text("Latest presence beacons from OpenClaw nodes. Updated periodically.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 16)

            SettingsRefreshButton(isLoading: self.store.isLoading) {
                Task { await self.store.refresh() }
            }
        }
    }

    @ViewBuilder
    private func instanceRow(_ inst: InstanceInfo) -> some View {
        let isGateway = (inst.mode ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "gateway"
        let prettyPlatform = inst.platform.flatMap { self.prettyPlatform($0) }
        let device = DeviceModelCatalog.presentation(
            deviceFamily: inst.deviceFamily,
            modelIdentifier: inst.modelIdentifier)

        HStack(alignment: .top, spacing: 12) {
            self.leadingDeviceIcon(inst, device: device)
                .frame(width: 28, height: 28, alignment: .center)
                .padding(.top, 1)

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(inst.host ?? "unknown host").font(.subheadline.bold())
                    self.presenceIndicator(inst)
                    if let ip = inst.ip { Text("(") + Text(ip).monospaced() + Text(")") }
                }

                HStack(spacing: 8) {
                    if let version = inst.version {
                        self.label(icon: "shippingbox", text: version)
                    }

                    if let device {
                        // Avoid showing generic "Mac"/"iPhone"/etc; prefer the concrete model name.
                        let family = (inst.deviceFamily ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                        let isGeneric = !family.isEmpty && device.title == family
                        if !isGeneric {
                            if let prettyPlatform {
                                self.label(icon: device.symbol, text: "\(device.title) · \(prettyPlatform)")
                            } else {
                                self.label(icon: device.symbol, text: device.title)
                            }
                        } else if let prettyPlatform, let platform = inst.platform {
                            self.label(icon: self.platformIcon(platform), text: prettyPlatform)
                        }
                    } else if let prettyPlatform, let platform = inst.platform {
                        self.label(icon: self.platformIcon(platform), text: prettyPlatform)
                    }

                    if let mode = inst.mode { self.label(icon: "network", text: mode) }
                }
                .layoutPriority(1)

                if !isGateway, self.shouldShowUpdateRow(inst) {
                    HStack(spacing: 8) {
                        Spacer(minLength: 0)

                        // Last local input is helpful for interactive nodes, but noisy/meaningless for the gateway.
                        if let secs = inst.lastInputSeconds {
                            self.label(icon: "clock", text: "\(secs)s ago")
                        }

                        if let update = self.updateSummaryText(inst, isGateway: isGateway) {
                            self.label(icon: "arrow.clockwise", text: update)
                                .help(self.presenceUpdateSourceHelp(inst.reason ?? ""))
                        }
                    }
                    .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 6)
        .help(inst.text)
        .contextMenu {
            Button("Copy Debug Summary") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(inst.text, forType: .string)
            }
        }
    }

    private func label(icon: String?, text: String) -> some View {
        HStack(spacing: 4) {
            if let icon {
                if icon == Self.androidSymbolToken {
                    AndroidMark()
                        .foregroundStyle(.secondary)
                        .frame(width: 12, height: 12, alignment: .center)
                } else if self.isSystemSymbolAvailable(icon) {
                    Image(systemName: icon).foregroundStyle(.secondary).font(.caption)
                }
            }
            Text(text)
        }
        .font(.footnote)
    }

    private func presenceIndicator(_ inst: InstanceInfo) -> some View {
        let status = self.presenceStatus(for: inst)
        return HStack(spacing: 4) {
            Circle()
                .fill(status.color)
                .frame(width: 6, height: 6)
                .accessibilityHidden(true)
            Text(status.label)
                .foregroundStyle(.secondary)
        }
        .font(.caption)
        .help("Presence updated \(inst.ageDescription).")
        .accessibilityLabel("\(status.label) presence")
    }

    private func presenceStatus(for inst: InstanceInfo) -> (label: String, color: Color) {
        let nowMs = Date().timeIntervalSince1970 * 1000
        let ageSeconds = max(0, Int((nowMs - inst.ts) / 1000))
        if ageSeconds <= 120 { return ("Active", .green) }
        if ageSeconds <= 300 { return ("Idle", .yellow) }
        return ("Stale", .gray)
    }

    @ViewBuilder
    private func leadingDeviceIcon(_ inst: InstanceInfo, device: DevicePresentation?) -> some View {
        let symbol = self.leadingDeviceSymbol(inst, device: device)
        if symbol == Self.androidSymbolToken {
            AndroidMark()
                .foregroundStyle(.secondary)
                .frame(width: 24, height: 24, alignment: .center)
                .accessibilityHidden(true)
        } else {
            Image(systemName: symbol)
                .font(.system(size: 26, weight: .regular))
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
        }
    }

    private static let androidSymbolToken = "android"

    private func leadingDeviceSymbol(_ inst: InstanceInfo, device: DevicePresentation?) -> String {
        let family = (inst.deviceFamily ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if family == "android" {
            return Self.androidSymbolToken
        }

        if let title = device?.title.lowercased() {
            if title.contains("mac studio") {
                return self.safeSystemSymbol("macstudio", fallback: "desktopcomputer")
            }
            if title.contains("macbook") {
                return self.safeSystemSymbol("laptopcomputer", fallback: "laptopcomputer")
            }
            if title.contains("ipad") {
                return self.safeSystemSymbol("ipad", fallback: "ipad")
            }
            if title.contains("iphone") {
                return self.safeSystemSymbol("iphone", fallback: "iphone")
            }
        }

        if let symbol = device?.symbol {
            return self.safeSystemSymbol(symbol, fallback: "cpu")
        }

        if let platform = inst.platform {
            return self.safeSystemSymbol(self.platformIcon(platform), fallback: "cpu")
        }

        return "cpu"
    }

    private func shouldShowUpdateRow(_ inst: InstanceInfo) -> Bool {
        if inst.lastInputSeconds != nil { return true }
        if self.updateSummaryText(inst, isGateway: false) != nil { return true }
        return false
    }

    private func safeSystemSymbol(_ preferred: String, fallback: String) -> String {
        if self.isSystemSymbolAvailable(preferred) { return preferred }
        return fallback
    }

    private func isSystemSymbolAvailable(_ name: String) -> Bool {
        NSImage(systemSymbolName: name, accessibilityDescription: nil) != nil
    }

    private struct AndroidMark: View {
        var body: some View {
            GeometryReader { geo in
                let w = geo.size.width
                let h = geo.size.height
                let headHeight = h * 0.68
                let headWidth = w * 0.92
                let headY = h * 0.18
                let corner = headHeight * 0.28

                ZStack {
                    RoundedRectangle(cornerRadius: corner, style: .continuous)
                        .frame(width: headWidth, height: headHeight)
                        .position(x: w / 2, y: headY + headHeight / 2)

                    Circle()
                        .frame(width: max(1, w * 0.1), height: max(1, w * 0.1))
                        .position(x: w * 0.38, y: headY + headHeight * 0.55)
                        .blendMode(.destinationOut)

                    Circle()
                        .frame(width: max(1, w * 0.1), height: max(1, w * 0.1))
                        .position(x: w * 0.62, y: headY + headHeight * 0.55)
                        .blendMode(.destinationOut)

                    Rectangle()
                        .frame(width: max(1, w * 0.08), height: max(1, h * 0.18))
                        .rotationEffect(.degrees(-25))
                        .position(x: w * 0.34, y: h * 0.12)

                    Rectangle()
                        .frame(width: max(1, w * 0.08), height: max(1, h * 0.18))
                        .rotationEffect(.degrees(25))
                        .position(x: w * 0.66, y: h * 0.12)
                }
                .compositingGroup()
            }
        }
    }

    private func platformIcon(_ raw: String) -> String {
        let (prefix, _) = PlatformLabelFormatter.parse(raw)
        switch prefix {
        case "macos":
            return "laptopcomputer"
        case "ios":
            return "iphone"
        case "ipados":
            return "ipad"
        case "tvos":
            return "appletv"
        case "watchos":
            return "applewatch"
        default:
            return "cpu"
        }
    }

    private func prettyPlatform(_ raw: String) -> String? {
        PlatformLabelFormatter.pretty(raw)
    }

    private func presenceUpdateSourceShortText(_ reason: String) -> String? {
        let trimmed = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        switch trimmed {
        case "self":
            return "Self"
        case "connect":
            return "Connect"
        case "disconnect":
            return "Disconnect"
        case "node-connected":
            return "Node connect"
        case "node-disconnected":
            return "Node disconnect"
        case "launch":
            return "Launch"
        case "periodic":
            return "Heartbeat"
        case "instances-refresh":
            return "Instances"
        case "seq gap":
            return "Resync"
        default:
            return trimmed
        }
    }

    private func updateSummaryText(_ inst: InstanceInfo, isGateway: Bool) -> String? {
        // For gateway rows, omit the "updated via/by" provenance entirely.
        if isGateway {
            return nil
        }

        let age = inst.ageDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !age.isEmpty else { return nil }

        let source = self.presenceUpdateSourceShortText(inst.reason ?? "")
        if let source, !source.isEmpty {
            return "\(age) · \(source)"
        }
        return age
    }

    private func presenceUpdateSourceHelp(_ reason: String) -> String {
        let trimmed = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            return "Why this presence entry was last updated (debug marker)."
        }
        return "Why this presence entry was last updated (debug marker). Raw: \(trimmed)"
    }
}

#if DEBUG
extension InstancesSettings {
    static func exerciseForTesting() {
        let view = InstancesSettings(store: InstancesStore(isPreview: true))
        let mac = InstanceInfo(
            id: "mac",
            host: "studio",
            ip: "10.0.0.2",
            version: "1.2.3",
            platform: "macOS 14.2",
            deviceFamily: "Mac",
            modelIdentifier: "Mac14,10",
            lastInputSeconds: 12,
            mode: "local",
            reason: "self",
            text: "Mac Studio",
            ts: 1_700_000_000_000)
        let genericIOS = InstanceInfo(
            id: "iphone",
            host: "phone",
            ip: "10.0.0.3",
            version: "2.0.0",
            platform: "iOS 18.0",
            deviceFamily: "iPhone",
            modelIdentifier: nil,
            lastInputSeconds: 35,
            mode: "node",
            reason: "connect",
            text: "iPhone node",
            ts: 1_700_000_100_000)
        let android = InstanceInfo(
            id: "android",
            host: "pixel",
            ip: nil,
            version: "3.1.0",
            platform: "Android 14",
            deviceFamily: "Android",
            modelIdentifier: nil,
            lastInputSeconds: 90,
            mode: "node",
            reason: "seq gap",
            text: "Android node",
            ts: 1_700_000_200_000)
        let gateway = InstanceInfo(
            id: "gateway",
            host: "gateway",
            ip: "10.0.0.9",
            version: "4.0.0",
            platform: "Linux",
            deviceFamily: nil,
            modelIdentifier: nil,
            lastInputSeconds: nil,
            mode: "gateway",
            reason: "periodic",
            text: "Gateway",
            ts: 1_700_000_300_000)

        _ = view.instanceRow(mac)
        _ = view.instanceRow(genericIOS)
        _ = view.instanceRow(android)
        _ = view.instanceRow(gateway)

        _ = view.leadingDeviceSymbol(
            mac,
            device: DevicePresentation(title: "Mac Studio", symbol: "macstudio"))
        _ = view.leadingDeviceSymbol(
            mac,
            device: DevicePresentation(title: "MacBook Pro", symbol: "laptopcomputer"))
        _ = view.leadingDeviceSymbol(android, device: nil)
        _ = view.platformIcon("tvOS 17.1")
        _ = view.platformIcon("watchOS 10")
        _ = view.platformIcon("unknown 1.0")
        _ = view.prettyPlatform("macOS 14.2")
        _ = view.prettyPlatform("iOS 18")
        _ = view.prettyPlatform("ipados 17.1")
        _ = view.prettyPlatform("linux")
        _ = view.prettyPlatform("   ")
        _ = PlatformLabelFormatter.parse("macOS 14.1")
        _ = PlatformLabelFormatter.parse(" ")
        _ = view.presenceUpdateSourceShortText("self")
        _ = view.presenceUpdateSourceShortText("instances-refresh")
        _ = view.presenceUpdateSourceShortText("seq gap")
        _ = view.presenceUpdateSourceShortText("custom")
        _ = view.presenceUpdateSourceShortText(" ")
        _ = view.updateSummaryText(mac, isGateway: false)
        _ = view.updateSummaryText(gateway, isGateway: true)
        _ = view.presenceUpdateSourceHelp("")
        _ = view.presenceUpdateSourceHelp("connect")
        _ = view.safeSystemSymbol("not-a-symbol", fallback: "cpu")
        _ = view.isSystemSymbolAvailable("sparkles")
        _ = view.label(icon: "android", text: "Android")
        _ = view.label(icon: "sparkles", text: "Sparkles")
        _ = view.label(icon: nil, text: "Plain")
        _ = AndroidMark().body
    }
}

struct InstancesSettings_Previews: PreviewProvider {
    static var previews: some View {
        InstancesSettings(store: .preview())
            .frame(width: SettingsTab.windowWidth, height: SettingsTab.windowHeight)
    }
}
#endif
