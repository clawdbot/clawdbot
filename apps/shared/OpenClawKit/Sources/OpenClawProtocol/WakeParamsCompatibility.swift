extension WakeParams {
    // periphery:ignore - Shipped before sessionKey; remove only at a breaking protocol API window.
    public init(
        mode: AnyCodable,
        text: String)
    {
        self.init(mode: mode, text: text, sessionkey: nil)
    }
}
