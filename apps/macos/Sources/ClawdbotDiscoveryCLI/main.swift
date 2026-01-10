import ClawdbotDiscovery
import Foundation

struct DiscoveryOptions {
    var timeoutMs: Int = 2000
    var json: Bool = false
    var includeLocal: Bool = false
    var help: Bool = false

    static func parse(_ args: [String]) -> DiscoveryOptions {
        var opts = DiscoveryOptions()
        var i = 0
        while i < args.count {
            let arg = args[i]
            switch arg {
            case "-h", "--help":
                opts.help = true
            case "--json":
                opts.json = true
            case "--include-local":
                opts.includeLocal = true
            case "--timeout":
                let next = (i + 1 < args.count) ? args[i + 1] : nil
                if let next, let parsed = Int(next.trimmingCharacters(in: .whitespacesAndNewlines)) {
                    opts.timeoutMs = max(100, parsed)
                    i += 1
                }
            default:
                break
            }
            i += 1
        }
        return opts
    }
}

struct DiscoveryOutput: Encodable {
    struct Gateway: Encodable {
        var displayName: String
        var lanHost: String?
        var tailnetDns: String?
        var sshPort: Int
        var gatewayPort: Int?
        var cliPath: String?
        var stableID: String
        var debugID: String
        var isLocal: Bool
    }

    var status: String
    var timeoutMs: Int
    var includeLocal: Bool
    var count: Int
    var gateways: [Gateway]
}

@main
struct ClawdbotDiscoveryCLI {
    static func main() async {
        let opts = DiscoveryOptions.parse(Array(CommandLine.arguments.dropFirst()))
        if opts.help {
            print("""
            clawdbot-mac-discovery

            Usage:
              clawdbot-mac-discovery [--timeout <ms>] [--json] [--include-local]

            Options:
              --timeout <ms>     Discovery window in milliseconds (default: 2000)
              --json             Emit JSON
              --include-local    Include gateways considered local
              -h, --help         Show help
            """)
            return
        }

        let displayName = Host.current().localizedName ?? ProcessInfo.processInfo.hostName
        let model = GatewayDiscoveryModel(
            localDisplayName: displayName,
            filterLocalGateways: !opts.includeLocal)

        await MainActor.run {
            model.start()
        }

        let nanos = UInt64(max(100, opts.timeoutMs)) * 1_000_000
        try? await Task.sleep(nanoseconds: nanos)

        let gateways = await MainActor.run { model.gateways }
        let status = await MainActor.run { model.statusText }

        await MainActor.run {
            model.stop()
        }

        if opts.json {
            let payload = DiscoveryOutput(
                status: status,
                timeoutMs: opts.timeoutMs,
                includeLocal: opts.includeLocal,
                count: gateways.count,
                gateways: gateways.map {
                    DiscoveryOutput.Gateway(
                        displayName: $0.displayName,
                        lanHost: $0.lanHost,
                        tailnetDns: $0.tailnetDns,
                        sshPort: $0.sshPort,
                        gatewayPort: $0.gatewayPort,
                        cliPath: $0.cliPath,
                        stableID: $0.stableID,
                        debugID: $0.debugID,
                        isLocal: $0.isLocal)
                })
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            if let data = try? encoder.encode(payload),
               let json = String(data: data, encoding: .utf8)
            {
                print(json)
            } else {
                print("{\"error\":\"failed to encode JSON\"}")
            }
            return
        }

        print("Gateway Discovery (macOS NWBrowser)")
        print("Status: \(status)")
        print("Found \(gateways.count) gateway(s)\(opts.includeLocal ? "" : " (local filtered)")")
        if gateways.isEmpty { return }

        for gateway in gateways {
            let hosts = [gateway.tailnetDns, gateway.lanHost]
                .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
                .joined(separator: ", ")
            print("- \(gateway.displayName)")
            print("  hosts: \(hosts.isEmpty ? "(none)" : hosts)")
            print("  ssh: \(gateway.sshPort)")
            if let port = gateway.gatewayPort {
                print("  gatewayPort: \(port)")
            }
            if let cliPath = gateway.cliPath {
                print("  cliPath: \(cliPath)")
            }
            print("  isLocal: \(gateway.isLocal)")
            print("  stableID: \(gateway.stableID)")
            print("  debugID: \(gateway.debugID)")
        }
    }
}
