import Foundation

// Mac PropertyManager asset API extensions (mirrors iPhone client).
// Uses v1/ path prefix compatible with Mac PropertyAPIClient.makeURL.

extension PropertyAPIClient {
    func fetchAssets() async throws -> [MacRanchAsset] {
        let url = try makeURL("v1/assets")
        let (data, response) = try await URLSession.shared.data(from: url)
        try validate(response, data: data)
        return try decoder.decode([MacRanchAsset].self, from: data)
    }

    func fetchAsset(id: UUID) async throws -> MacRanchAsset {
        let url = try makeURL("v1/assets/\(id.uuidString)")
        let (data, response) = try await URLSession.shared.data(from: url)
        try validate(response, data: data)
        return try decoder.decode(MacRanchAsset.self, from: data)
    }

    func fetchMeterReadings(assetId: UUID, limit: Int = 50) async throws -> [MacMeterReading] {
        let url = try makeURL("v1/assets/\(assetId.uuidString)/meter-readings?limit=\(limit)")
        let (data, response) = try await URLSession.shared.data(from: url)
        try validate(response, data: data)
        let page = try decoder.decode(MacMeterReadingPage.self, from: data)
        return page.items
    }

    func submitMeterReading(
        assetId: UUID,
        value: Double,
        note: String?,
        entryMethod: String = "manual"
    ) async throws -> MacRanchAsset {
        let url = try makeURL("v1/assets/\(assetId.uuidString)/meter-readings")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        meterApplyAuth(&request)
        var body: [String: Any] = ["value": String(value), "entry_method": entryMethod]
        if let note, !note.isEmpty { body["note"] = note }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse, http.statusCode == 409 {
            if let preview = try? JSONDecoder().decode(MacLowerReadingPreview.self, from: data),
               preview.code == "LOWER_READING_CONFIRMATION_REQUIRED" {
                throw MacMeterError.lowerReadingConfirmation(preview)
            }
        }
        try validate(response, data: data)
        let result = try decoder.decode(MacMeterReadingResult.self, from: data)
        return result.asset
    }

    func confirmMeterReading(
        assetId: UUID,
        preview: MacLowerReadingPreview,
        correctionReason: String,
        note: String? = nil
    ) async throws -> MacRanchAsset {
        let url = try makeURL("v1/assets/\(assetId.uuidString)/meter-readings/confirm")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        meterApplyAuth(&request)
        var body: [String: Any] = [
            "preview_token": preview.previewToken,
            "correction_reason": correctionReason,
            "operator_identity": "mac-operator",
        ]
        if let note, !note.isEmpty { body["note"] = note }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: request)
        try validate(response, data: data)
        let result = try decoder.decode(MacMeterReadingResult.self, from: data)
        return result.asset
    }

    func activateMeter(assetId: UUID) async throws -> MacRanchAsset {
        let url = try makeURL("v1/assets/\(assetId.uuidString)/activate-meter")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        meterApplyAuth(&request)
        request.httpBody = try JSONSerialization.data(withJSONObject: [:] as [String: String])
        let (data, response) = try await URLSession.shared.data(for: request)
        try validate(response, data: data)
        let result = try decoder.decode(MacActivateMeterResult.self, from: data)
        return result.asset
    }

    /// Auth headers for meter mutating calls (no-op when auth disabled on server).
    fileprivate func meterApplyAuth(_ request: inout URLRequest) {
        request.setValue("mac-operator", forHTTPHeaderField: "X-Operator-Identity")
    }
}

enum MacMeterError: LocalizedError {
    case lowerReadingConfirmation(MacLowerReadingPreview)

    var errorDescription: String? {
        switch self {
        case .lowerReadingConfirmation:
            return "Reading is lower than current. Confirmation required."
        }
    }
}

private struct MacMeterReadingPage: Codable {
    var items: [MacMeterReading]
}

private struct MacMeterReadingResult: Codable {
    var asset: MacRanchAsset
}

private struct MacActivateMeterResult: Codable {
    var asset: MacRanchAsset
}

struct MacLowerReadingPreview: Codable {
    var code: String
    var previousValue: String?
    var proposedValue: String?
    var options: [String]?
    var previewToken: String

    enum CodingKeys: String, CodingKey {
        case code, options
        case previousValue = "previous_value"
        case proposedValue = "proposed_value"
        case previewToken = "preview_token"
    }
}

struct MacAssetMeter: Codable, Hashable, Identifiable {
    var id: UUID { assetId }
    let assetId: UUID
    var meterType: String
    var currentValue: Double?
    var unit: String
    var latestReadingAt: Date?
    var activated: Bool?

    enum CodingKeys: String, CodingKey {
        case assetId = "asset_id"
        case meterType = "meter_type"
        case currentValue = "current_value"
        case unit
        case latestReadingAt = "latest_reading_at"
        case activated
    }

    init(from asset: MacRanchAsset) {
        assetId = asset.id
        meterType = asset.meter?.meterType ?? "none"
        currentValue = asset.meter?.currentValue
        unit = asset.meter?.unit ?? ""
        latestReadingAt = asset.meter?.latestReadingAt
        activated = asset.meter?.activated
    }
}

struct MacRanchAsset: Identifiable, Codable, Hashable {
    let id: UUID
    var externalId: String
    var name: String
    var category: String?
    var meter: MacMeterInfo?
    var proposedMeter: MacProposedMeter?
    var meterActivatedAt: Date?
    var tasks: [MacAssetTaskSummary]?
    var pmSummary: MacPMSummary?

    enum CodingKeys: String, CodingKey {
        case id, name, category, meter, tasks
        case externalId = "external_id"
        case proposedMeter = "proposed_meter"
        case meterActivatedAt = "meter_activated_at"
        case pmSummary = "pm_summary"
    }

    var meterNeedsActivation: Bool {
        meterActivatedAt == nil && proposedMeter?.meterType != nil && proposedMeter?.meterType != "none"
    }
}

struct MacProposedMeter: Codable, Hashable {
    var meterType: String?
    var unit: String?

    enum CodingKeys: String, CodingKey {
        case meterType = "meter_type"
        case unit
    }
}

struct MacMeterInfo: Codable, Hashable {
    var meterType: String
    var currentValue: Double?
    var unit: String
    var latestReadingAt: Date?
    var activated: Bool?

    enum CodingKeys: String, CodingKey {
        case meterType = "meter_type"
        case currentValue = "current_value"
        case unit
        case latestReadingAt = "latest_reading_at"
        case activated
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        meterType = try c.decode(String.self, forKey: .meterType)
        unit = try c.decodeIfPresent(String.self, forKey: .unit) ?? ""
        latestReadingAt = try c.decodeIfPresent(Date.self, forKey: .latestReadingAt)
        activated = try c.decodeIfPresent(Bool.self, forKey: .activated)
        currentValue = MacDecimal.decode(c, key: .currentValue)
    }

    var hasMeter: Bool { meterType != "none" && (activated ?? true) }
    var updateTitle: String {
        switch meterType {
        case "runtime_hours": return "Update Hours"
        case "mileage": return "Update Miles"
        case "cycles": return "Update Cycles"
        default: return "Update Meter"
        }
    }
}

struct MacAssetTaskSummary: Codable, Hashable, Identifiable {
    let id: UUID
    var item: String
    var remainingMeter: Double?
    var overdueMeter: Bool?

    enum CodingKeys: String, CodingKey {
        case id, item
        case remainingMeter = "remaining_meter"
        case overdueMeter = "overdue_meter"
    }
}

struct MacPMSummary: Codable, Hashable {
    var overdueMeterCount: Int
    enum CodingKeys: String, CodingKey { case overdueMeterCount = "overdue_meter_count" }
}

struct MacMeterReading: Identifiable, Codable, Hashable {
    let id: UUID
    var value: Double
    var readingAt: Date
    var usageSincePrevious: Double?

    enum CodingKeys: String, CodingKey {
        case id, value
        case readingAt = "reading_at"
        case usageSincePrevious = "usage_since_previous"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        readingAt = try c.decode(Date.self, forKey: .readingAt)
        value = MacDecimal.decode(c, key: .value) ?? 0
        usageSincePrevious = MacDecimal.decode(c, key: .usageSincePrevious)
    }
}

private enum MacDecimal {
    static func decode<K: CodingKey>(_ c: KeyedDecodingContainer<K>, key: K) -> Double? {
        if let d = try? c.decodeIfPresent(Double.self, forKey: key) {
            return d
        }
        guard let s = try? c.decode(String.self, forKey: key), !s.isEmpty else {
            return nil
        }
        return Double(s)
    }
}
