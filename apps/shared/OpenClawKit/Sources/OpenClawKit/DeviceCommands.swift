import Foundation

public enum OpenClawDeviceCommand: String, Codable, Sendable {
    case status = "device.status"
    case info = "device.info"
}

public enum OpenClawBatteryState: String, Codable, Sendable {
    case unknown
    case unplugged
    case charging
    case full
}

public enum OpenClawThermalState: String, Codable, Sendable {
    case nominal
    case fair
    case serious
    case critical
}

public enum OpenClawNetworkPathStatus: String, Codable, Sendable {
    case satisfied
    case unsatisfied
    case requiresConnection
}

public enum OpenClawNetworkInterfaceType: String, Codable, Sendable {
    case wifi
    case cellular
    case wired
    case other
}

public struct OpenClawBatteryStatusPayload: Codable, Sendable, Equatable {
    /// Battery charge level as a normalized fraction of full charge, 0.0–1.0.
    /// Not a percentage: 1.0 == fully charged. `nil` when unavailable.
    public var level: Double?
    /// Convenience percentage view of `level`, 0–100 (rounded). `nil` when `level` is `nil`.
    public var levelPercent: Int?
    public var state: OpenClawBatteryState
    public var lowPowerModeEnabled: Bool

    public init(
        level: Double?,
        state: OpenClawBatteryState,
        lowPowerModeEnabled: Bool,
        levelPercent: Int? = nil)
    {
        self.level = level
        self.levelPercent = levelPercent
        self.state = state
        self.lowPowerModeEnabled = lowPowerModeEnabled
    }
}

public struct OpenClawThermalStatusPayload: Codable, Sendable, Equatable {
    public var state: OpenClawThermalState

    public init(state: OpenClawThermalState) {
        self.state = state
    }
}

public struct OpenClawStorageStatusPayload: Codable, Sendable, Equatable {
    public var totalBytes: Int64
    public var freeBytes: Int64
    public var usedBytes: Int64

    public init(totalBytes: Int64, freeBytes: Int64, usedBytes: Int64) {
        self.totalBytes = totalBytes
        self.freeBytes = freeBytes
        self.usedBytes = usedBytes
    }
}

public struct OpenClawNetworkStatusPayload: Codable, Sendable, Equatable {
    public var status: OpenClawNetworkPathStatus
    public var isExpensive: Bool
    public var isConstrained: Bool
    public var interfaces: [OpenClawNetworkInterfaceType]

    public init(
        status: OpenClawNetworkPathStatus,
        isExpensive: Bool,
        isConstrained: Bool,
        interfaces: [OpenClawNetworkInterfaceType])
    {
        self.status = status
        self.isExpensive = isExpensive
        self.isConstrained = isConstrained
        self.interfaces = interfaces
    }
}

public struct OpenClawDeviceStatusPayload: Codable, Sendable, Equatable {
    public var battery: OpenClawBatteryStatusPayload
    public var thermal: OpenClawThermalStatusPayload
    public var storage: OpenClawStorageStatusPayload
    public var network: OpenClawNetworkStatusPayload
    public var uptimeSeconds: Double

    public init(
        battery: OpenClawBatteryStatusPayload,
        thermal: OpenClawThermalStatusPayload,
        storage: OpenClawStorageStatusPayload,
        network: OpenClawNetworkStatusPayload,
        uptimeSeconds: Double)
    {
        self.battery = battery
        self.thermal = thermal
        self.storage = storage
        self.network = network
        self.uptimeSeconds = uptimeSeconds
    }
}

public struct OpenClawDeviceInfoPayload: Codable, Sendable, Equatable {
    public var deviceName: String
    public var modelIdentifier: String
    public var systemName: String
    public var systemVersion: String
    public var appVersion: String
    public var appBuild: String
    public var locale: String

    public init(
        deviceName: String,
        modelIdentifier: String,
        systemName: String,
        systemVersion: String,
        appVersion: String,
        appBuild: String,
        locale: String)
    {
        self.deviceName = deviceName
        self.modelIdentifier = modelIdentifier
        self.systemName = systemName
        self.systemVersion = systemVersion
        self.appVersion = appVersion
        self.appBuild = appBuild
        self.locale = locale
    }
}
