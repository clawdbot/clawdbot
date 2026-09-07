import Foundation
import OpenClawIPC

struct MacControlOptions {
    enum SecretSource: Equatable {
        case file(String)
        case stdin
    }

    var request: MacControlRequest
    var profile: MacControlProfile
    var json = false
    var launch = true
    var timeoutMs = 15000
    var yes = false
    var help = false
    var primaryOnly = false
    var tokenSource: SecretSource?
    var passwordSource: SecretSource?

    static func parse(_ args: [String], environment: [String: String] = [:]) throws -> Self {
        let (values, flags, words) = try self.tokenize(args)
        let profile = try MacControlProfile(rawValue: values["--profile"] ?? environment["OPENCLAW_PROFILE"])
        let command = words.first ?? "status"
        let subcommand = words.count > 1 ? words[1] : ""
        let operation = try self.operation(
            command: command,
            subcommand: subcommand,
            help: flags.contains("--help") || flags.contains("-h"))
        var options = Self(request: MacControlRequest(operation: operation), profile: profile)
        options.primaryOnly = command == "primary" && subcommand == "show"
        options.json = flags.contains("--json")
        options.launch = !flags.contains("--no-launch")
        options.yes = flags.contains("--yes")
        options.help = flags.contains("--help") || flags.contains("-h")
        if options.help { return options }
        guard !(flags.contains("--launch") && flags.contains("--no-launch")) else {
            throw self.usage("Choose --launch or --no-launch.")
        }
        options.timeoutMs = operation == "gateway.add" || operation == "gateway.reconnect" ? 310_000 : 15000
        if let timeout = values["--timeout"] {
            guard let milliseconds = Int(timeout), (1...3_600_000).contains(milliseconds) else {
                throw self.usage("--timeout must be an integer from 1 to 3600000 milliseconds.")
            }
            options.timeoutMs = milliseconds
        }
        options.tokenSource = try self.secretSource(values: values, flags: flags, kind: "token")
        options.passwordSource = try self.secretSource(values: values, flags: flags, kind: "password")
        guard !(options.tokenSource == .stdin && options.passwordSource == .stdin) else {
            throw self.usage("Standard input can supply only one secret.")
        }
        let globals: Set = ["--profile", "--timeout", "--json", "--launch", "--no-launch"]
        let secrets: Set = ["--token-file", "--password-file", "--token-stdin", "--password-stdin"]
        var allowed = globals
        switch operation {
        case "primary.set":
            allowed.formUnion(secrets)
            allowed.formUnion([
                "--ssh-target", "--remote-port", "--local-port", "--identity", "--ssh-host-key-policy",
                "--direct-url", "--tls-fingerprint", "--local",
            ])
            try options.configurePrimary(values: values, flags: flags)
        case "gateway.add":
            allowed.formUnion(secrets)
            allowed.formUnion(["--url", "--browser"])
            guard words.count == 3, let url = values["--url"], !url.isEmpty else {
                throw self.usage("gateway add requires a name and --url.")
            }
            options.request.name = words[2]
            options.request.url = url
            options.request.browser = flags.contains("--browser")
                || (options.tokenSource == nil && options.passwordSource == nil)
        case "gateway.remove", "gateway.reconnect":
            if operation == "gateway.remove" { allowed.insert("--yes") }
            guard words.count == 3 else { throw self.usage("A Gateway id or name is required.") }
            options.request.idOrName = words[2]
        default: break
        }
        guard Set(values.keys).union(flags).isSubset(of: allowed) else {
            throw self.usage("An option is not supported by this command. Use --help.")
        }
        let expectedWords = command == "status" ? 1 :
            (operation.hasPrefix("gateway.") && operation != "gateway.list" ? 3 : 2)
        guard words.count == expectedWords || words.isEmpty else { throw self.usage("Unexpected command arguments.") }
        return options
    }

    private static func operation(command: String, subcommand: String, help: Bool) throws -> String {
        switch (command, subcommand) {
        case ("status", ""): return "status"
        case ("primary", "show"): return "status"
        case ("primary", "set"): return "primary.set"
        case ("primary", "clear"): return "primary.clear"
        case ("gateway", "list"): return "gateway.list"
        case ("gateway", "add"): return "gateway.add"
        case ("gateway", "remove"): return "gateway.remove"
        case ("gateway", "reconnect"): return "gateway.reconnect"
        default:
            if help { return "status" }
            throw self.usage("Expected status, primary show|set|clear, or gateway list|add|remove|reconnect.")
        }
    }

    private static func tokenize(_ args: [String]) throws -> ([String: String], Set<String>, [String]) {
        var values: [String: String] = [:]
        var flags = Set<String>()
        var words: [String] = []
        let valueFlags: Set = [
            "--profile", "--timeout", "--ssh-target", "--remote-port", "--local-port", "--identity",
            "--ssh-host-key-policy", "--direct-url", "--tls-fingerprint", "--url", "--token-file", "--password-file",
        ]
        let switchFlags: Set = [
            "--json", "--launch", "--no-launch", "--local", "--browser", "--token-stdin", "--password-stdin",
            "--yes", "--help", "-h",
        ]
        var index = 0
        while index < args.count {
            let argument = args[index]
            if argument == "--token" || argument == "--password"
                || argument.hasPrefix("--token=") || argument.hasPrefix("--password=")
            {
                throw self.usage("Secrets must use --token-file/--token-stdin or --password-file/--password-stdin.")
            }
            if valueFlags.contains(argument) {
                guard values[argument] == nil, index + 1 < args.count, !args[index + 1].hasPrefix("--") else {
                    throw self.usage("A value is required exactly once for \(argument).")
                }
                index += 1
                values[argument] = args[index]
            } else if switchFlags.contains(argument) {
                flags.insert(argument)
            } else if argument.hasPrefix("-") {
                throw self.usage("Unknown option. Use --help for supported options.")
            } else {
                words.append(argument)
            }
            index += 1
        }
        return (values, flags, words)
    }

    private mutating func configurePrimary(values: [String: String], flags: Set<String>) throws {
        let modes = [values["--ssh-target"] != nil, values["--direct-url"] != nil, flags.contains("--local")]
        guard modes.filter(\.self).count == 1 else {
            throw Self.usage("Choose exactly one of --ssh-target, --direct-url, or --local.")
        }
        self.request.mode = flags.contains("--local") ? "local" : nil
        self.request
            .transport = values["--ssh-target"] != nil ? "ssh" : (values["--direct-url"] != nil ? "direct" : nil)
        self.request.sshTarget = values["--ssh-target"]
        self.request.url = values["--direct-url"]
        self.request.identityPath = values["--identity"]
        self.request.hostKeyPolicy = values["--ssh-host-key-policy"]
        self.request.tlsFingerprint = values["--tls-fingerprint"]
        self.request.remotePort = try Self.port(values["--remote-port"])
        self.request.localPort = try Self.port(values["--local-port"])
        if let policy = self.request.hostKeyPolicy, !["strict", "openssh"].contains(policy) {
            throw Self.usage("--ssh-host-key-policy must be strict or openssh.")
        }
        let sshFlags = ["--remote-port", "--local-port", "--identity", "--ssh-host-key-policy"]
        guard self.request.transport == "ssh" || !sshFlags.contains(where: { values[$0] != nil }) else {
            throw Self.usage("SSH options require --ssh-target.")
        }
        guard self.request.transport == "direct" || values["--tls-fingerprint"] == nil else {
            throw Self.usage("--tls-fingerprint requires --direct-url.")
        }
        guard self.request.mode != "local" || (self.tokenSource == nil && self.passwordSource == nil)
        else {
            throw Self.usage("--local does not accept remote credentials.")
        }
    }

    private static func secretSource(
        values: [String: String],
        flags: Set<String>,
        kind: String) throws -> SecretSource?
    {
        let file = values["--\(kind)-file"]
        let stdin = flags.contains("--\(kind)-stdin")
        guard file == nil || !stdin else { throw self.usage("Choose a file or standard input for each secret.") }
        return file.map(SecretSource.file) ?? (stdin ? .stdin : nil)
    }

    private static func port(_ raw: String?) throws -> Int? {
        guard let raw else { return nil }
        guard let port = Int(raw), (1...65535).contains(port) else {
            throw self.usage("Ports must be integers from 1 to 65535.")
        }
        return port
    }

    static func usage(_ message: String) -> MacControlError {
        MacControlError(code: "usage", message: message)
    }
}
