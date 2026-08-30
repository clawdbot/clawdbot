import Foundation
import Network

public enum GatewayDiscoveryBrowserSupport {
    @MainActor
    public static func makeBrowser(
        serviceType: String,
        domain: String,
        queueLabelPrefix: String,
        onState: @escaping @MainActor (NWBrowser.State) -> Void,
        onResults: @escaping @MainActor (Set<NWBrowser.Result>) -> Void) -> NWBrowser
    {
        let params = NWParameters.tcp
        params.includePeerToPeer = true
        let browser = NWBrowser(
            for: .bonjour(type: serviceType, domain: domain),
            using: params)

        browser.stateUpdateHandler = { state in
            Task { @MainActor in
                onState(state)
            }
        }
        browser.browseResultsChangedHandler = { results, _ in
            Task { @MainActor in
                onResults(results)
            }
        }
        browser.start(queue: DispatchQueue(label: "\(queueLabelPrefix).\(domain)"))
        return browser
    }
}
