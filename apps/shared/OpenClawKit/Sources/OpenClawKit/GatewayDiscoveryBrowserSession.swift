import Network

@MainActor
public final class GatewayDiscoveryBrowserSession {
    private var browsers: [String: NWBrowser] = [:]
    private var states: [String: NWBrowser.State] = [:]

    public init() {}

    public var isRunning: Bool {
        !self.browsers.isEmpty
    }

    public func start(
        queueLabelPrefix: String,
        onState: @escaping @MainActor (String, NWBrowser.State, String) -> Void,
        onResults: @escaping @MainActor (String, Set<NWBrowser.Result>) -> Void)
    {
        guard !self.isRunning else { return }
        for domain in OpenClawBonjour.gatewayServiceDomains {
            self.browsers[domain] = GatewayDiscoveryBrowserSupport.makeBrowser(
                serviceType: OpenClawBonjour.gatewayServiceType,
                domain: domain,
                queueLabelPrefix: queueLabelPrefix,
                onState: { [weak self] state in
                    guard let self else { return }
                    self.states[domain] = state
                    let status = GatewayDiscoveryStatusText.make(
                        states: Array(self.states.values), hasBrowsers: self.isRunning)
                    onState(domain, state, status)
                },
                onResults: { results in onResults(domain, results) })
        }
    }

    public func stop() {
        for browser in self.browsers.values {
            browser.cancel()
        }
        self.browsers = [:]
        self.states = [:]
    }
}
