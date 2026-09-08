import Darwin
import Foundation
import OpenClawIPC

func runMacControl(_ args: [String]) {
    do {
        var options = try MacControlOptions.parse(args, environment: ProcessInfo.processInfo.environment)
        if options.help { printMacControlUsage()
            return
        }
        if options.request.operation == "gateway.remove", !options.yes {
            guard isatty(STDIN_FILENO) == 1 else {
                throw MacControlOptions.usage("gateway remove requires --yes when standard input is not a terminal.")
            }
            fputs("Remove this saved Gateway and its credentials? [y/N] ", stderr)
            guard let answer = readLine()?.lowercased(), answer == "y" || answer == "yes" else {
                throw MacControlError(code: "cancelled", message: "Gateway removal cancelled.")
            }
        }
        options.request.token = try readMacControlSecret(options.tokenSource)
        options.request.password = try readMacControlSecret(options.passwordSource)
        if options.request.browser == true, options.request.token == nil, options.request.password == nil {
            fputs("Complete sign-in in your browser…\n", stderr)
        }
        let response = try MacControlClient(options: options).send(options.request)
        let result = try macControlResult(response, primaryOnly: options.primaryOnly)
        if options.json {
            guard let text = String(data: result, encoding: .utf8) else {
                throw MacControlError(code: "invalid_response", message: "The app returned invalid text.")
            }
            print(text)
        } else {
            try printMacControlResult(result, operation: options.request.operation, primaryOnly: options.primaryOnly)
        }
    } catch {
        let controlError = error as? MacControlError
            ?? MacControlError(code: "operation_failed", message: "The app control operation failed.")
        if args.contains("--json"),
           let data = try? JSONEncoder().encode(MacControlResponse<String>(error: controlError)),
           let text = String(data: data, encoding: .utf8)
        {
            fputs(text + "\n", stderr)
        } else {
            fputs("openclaw-mac: \(controlError.message)\n", stderr)
        }
        exit(controlError.code == "usage" || controlError
            .code == "invalid_profile" ? 1 : (controlError.code == "unreachable" ? 2 : 3))
    }
}

func macControlResult(_ response: Data, primaryOnly: Bool) throws -> Data {
    guard let object = try JSONSerialization.jsonObject(with: response) as? [String: Any],
          let ok = object["ok"] as? Bool
    else { throw MacControlError(code: "invalid_response", message: "The app returned an invalid response.") }
    if !ok {
        guard let error = object["error"] as? [String: String], let code = error["code"],
              let message = error["message"]
        else {
            throw MacControlError(code: "invalid_response", message: "The app returned an invalid error.")
        }
        throw MacControlError(code: code, message: message)
    }
    guard var result = object["result"] else {
        throw MacControlError(code: "invalid_response", message: "The app returned no result.")
    }
    if primaryOnly {
        guard let primary = (result as? [String: Any])?["primary"] else {
            throw MacControlError(code: "invalid_response", message: "The app returned no primary status.")
        }
        result = primary
    }
    return try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys, .fragmentsAllowed])
}

private func printMacControlResult(_ data: Data, operation: String, primaryOnly: Bool) throws {
    let decoder = JSONDecoder()
    if operation == "status", !primaryOnly {
        let status = try decoder.decode(MacControlStatus.self, from: data)
        print("OpenClaw \(status.app.version) (\(status.app.build)) · profile \(status.app.profile)")
        print("NAME\tCONNECTION\tURL")
        print("Primary (\(status.primary.mode))\t\(status.primary.connection.state)\t\(status.primary.url)")
        for gateway in status.gateways {
            printMacControlGateway(gateway)
        }
    } else if operation.hasPrefix("primary.") || primaryOnly {
        let primary = try decoder.decode(MacControlPrimaryStatus.self, from: data)
        print("MODE\tTRANSPORT\tCONNECTION\tURL")
        print("\(primary.mode)\t\(primary.transport ?? "—")\t\(primary.connection.state)\t\(primary.url)")
    } else if operation == "gateway.list" {
        print("NAME\tCONNECTION\tURL")
        for gateway in try decoder
            .decode([MacControlGatewayStatus].self, from: data)
        {
            printMacControlGateway(gateway)
        }
    } else if operation == "gateway.remove" {
        print("Gateway removed.")
    } else {
        try printMacControlGateway(decoder.decode(MacControlGatewayStatus.self, from: data))
    }
}

private func printMacControlGateway(_ gateway: MacControlGatewayStatus) {
    print("\(gateway.name)\t\(gateway.connection.state)\t\(gateway.url)")
    if let identity = gateway.identity {
        print("  \(identity.subject) · expires \(identity.expiresAt)")
    }
}

private func printMacControlUsage() {
    print("""
    openclaw-mac app control

    Usage:
      openclaw-mac status
      openclaw-mac primary show|clear
      openclaw-mac primary set --ssh-target user@host[:port]
        [--remote-port PORT] [--local-port PORT] [--identity PATH]
        [--ssh-host-key-policy strict|openssh] [secret options]
      openclaw-mac primary set --direct-url ws://host|wss://host [--tls-fingerprint SHA256] [secret options]
      openclaw-mac primary set --local
      openclaw-mac gateway list
      openclaw-mac gateway add NAME --url https://host[/base]|wss://host [--browser] [secret options]
      openclaw-mac gateway remove ID_OR_NAME [--yes]
      openclaw-mac gateway reconnect ID_OR_NAME

    Global options (before or after commands):
      --profile NAME     Overrides OPENCLAW_PROFILE; default profile when unset.
      --json             Print the result as JSON; errors are JSON on stderr.
      --timeout MS       Deadline: 15000 ms; gateway add/reconnect default to 310000 ms.
      --launch           Launch the app in the background if needed (default).
      --no-launch        Fail if the app is not reachable.

    Secret options:
      --token-file PATH | --token-stdin
      --password-file PATH | --password-stdin
      Secrets are read once; trailing newlines are removed. Do not pass secrets in arguments.

    Browser sign-in remains open until completed, failed, or timed out (up to 300 seconds).
    configure-remote remains available for offline preconfiguration.
    """)
}
