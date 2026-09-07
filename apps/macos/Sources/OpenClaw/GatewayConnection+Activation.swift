import CryptoKit
import Foundation
import OpenClawKit

extension GatewayConnection {
    static func defaultActivationBindingKey() -> SymmetricKey? {
        self.activationBindingKey(
            launchPolicy: .current,
            loadOrCreate: GatewayActivationBindingKeyStore.loadOrCreate)
    }

    static func activationBindingKey(
        launchPolicy: AppLaunchRuntimePlan,
        loadOrCreate: () -> SymmetricKey?) -> SymmetricKey?
    {
        guard launchPolicy.allowsGatewayUIKeychainAccess else { return nil }
        return loadOrCreate()
    }

    static func activationOwnershipFingerprint(
        config: Config,
        browserSession: GatewayBrowserSession? = nil,
        authBinding: GatewayAuthBinding? = nil,
        key: SymmetricKey?) -> String?
    {
        guard let key else { return nil }
        // The durable record is already keyed by the stable Gateway route identity.
        // Bind only auth here so an SSH tunnel's ephemeral local URL can rebind safely.
        var values = [config.token ?? "", config.password ?? ""]
        if let browserSession {
            values.append(contentsOf: [browserSession.provider.rawValue, browserSession.credentialFingerprint])
        }
        if authBinding?.source == .deviceToken {
            guard let credentialFingerprint = authBinding?.credentialFingerprint else { return nil }
            values.append(contentsOf: [GatewayAuthSource.deviceToken.rawValue, credentialFingerprint])
        }
        let framed = values.map { "\($0.utf8.count):\($0)" }.joined(separator: "|")
        let tag = HMAC<SHA256>.authenticationCode(for: Data(framed.utf8), using: key)
        return tag.map { String(format: "%02x", $0) }.joined()
    }
}
