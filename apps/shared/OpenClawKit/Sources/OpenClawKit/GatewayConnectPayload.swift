import Foundation
import OpenClawProtocol

enum GatewayConnectPayload {
    static func makeClient(
        options: GatewayConnectOptions,
        displayName: String,
        platform: String) -> [String: OpenClawProtocol.AnyCodable]
    {
        var client: [String: OpenClawProtocol.AnyCodable] = [
            "id": OpenClawProtocol.AnyCodable(options.clientId),
            "displayName": OpenClawProtocol.AnyCodable(displayName),
            "version": OpenClawProtocol.AnyCodable(
                Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"),
            "platform": OpenClawProtocol.AnyCodable(platform),
            "mode": OpenClawProtocol.AnyCodable(options.clientMode),
            "instanceId": OpenClawProtocol.AnyCodable(InstanceIdentity.instanceId),
            "deviceFamily": OpenClawProtocol.AnyCodable(InstanceIdentity.deviceFamily),
        ]
        if let model = InstanceIdentity.modelIdentifier {
            client["modelIdentifier"] = OpenClawProtocol.AnyCodable(model)
        }
        return client
    }
}
