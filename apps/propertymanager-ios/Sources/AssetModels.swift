import Foundation

struct AssetMeter: Codable, Hashable {
    var meterType: String
    var currentValue: Double?
    var unit: String
    var latestReadingAt: Date?
    var updatedAt: Date?
    var activated: Bool?

    enum CodingKeys: String, CodingKey {
        case meterType = "meter_type"
        case currentValue = "current_value"
        case unit
        case latestReadingAt = "latest_reading_at"
        case updatedAt = "updated_at"
        case activated
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        meterType = try c.decode(String.self, forKey: .meterType)
        unit = try c.decodeIfPresent(String.self, forKey: .unit) ?? ""
        latestReadingAt = try c.decodeIfPresent(Date.self, forKey: .latestReadingAt)
        updatedAt = try c.decodeIfPresent(Date.self, forKey: .updatedAt)
        activated = try c.decodeIfPresent(Bool.self, forKey: .activated)
        currentValue = Self.decodeDecimal(c, key: .currentValue)
    }

    private static func decodeDecimal(_ c: KeyedDecodingContainer<CodingKeys>, key: CodingKeys) -> Double? {
        if let d = try? c.decodeIfPresent(Double.self, forKey: key) { return d }
        if let s = try? c.decodeIfPresent(String.self, forKey: key), let s, !s.isEmpty {
            return Double(s)
        }
        return nil
    }

    var updateButtonTitle: String {
        switch meterType {
        case "runtime_hours": return "Update Hours"
        case "mileage": return "Update Miles"
        case "cycles": return "Update Cycles"
        default: return "Update Meter"
        }
    }

    var hasMeter: Bool { meterType != "none" && (activated ?? true) }
}

struct ProposedMeter: Codable, Hashable {
    var meterType: String?
    var unit: String?
    var activatedAt: Date?

    enum CodingKeys: String, CodingKey {
        case meterType = "meter_type"
        case unit
        case activatedAt = "activated_at"
    }
}

struct AssetTaskSummary: Codable, Hashable, Identifiable {
    var id: UUID
    var item: String
    var scheduleKind: String?
    var meterIntervalValue: Double?
    var meterIntervalUnit: String?
    var remainingMeter: Double?
    var overdueMeter: Bool?

    enum CodingKeys: String, CodingKey {
        case id, item
        case scheduleKind = "schedule_kind"
        case meterIntervalValue = "meter_interval_value"
        case meterIntervalUnit = "meter_interval_unit"
        case remainingMeter = "remaining_meter"
        case overdueMeter = "overdue_meter"
    }
}

struct AssetPMSummary: Codable, Hashable {
    var overdueMeterCount: Int
    var dueSoonCount: Int

    enum CodingKeys: String, CodingKey {
        case overdueMeterCount = "overdue_meter_count"
        case dueSoonCount = "due_soon_count"
    }
}

struct RanchAsset: Identifiable, Codable, Hashable {
    let id: UUID
    var externalId: String
    var name: String
    var manufacturer: String?
    var model: String?
    var category: String?
    var location: String?
    var aliases: [String]?
    var qrToken: String?
    var meter: AssetMeter?
    var proposedMeter: ProposedMeter?
    var meterActivatedAt: Date?
    var tasks: [AssetTaskSummary]?
    var pmSummary: AssetPMSummary?

    enum CodingKeys: String, CodingKey {
        case id, name, manufacturer, model, category, location, aliases, tasks, meter
        case externalId = "external_id"
        case qrToken = "qr_token"
        case proposedMeter = "proposed_meter"
        case meterActivatedAt = "meter_activated_at"
        case pmSummary = "pm_summary"
    }

    var meterNeedsActivation: Bool {
        meterActivatedAt == nil && proposedMeter?.meterType != nil && proposedMeter?.meterType != "none"
    }
}

struct MeterReading: Identifiable, Codable, Hashable {
    let id: UUID
    var assetId: UUID
    var value: Double
    var readingAt: Date
    var entryMethod: String?
    var note: String?
    var correctionReason: String?
    var usageSincePrevious: Double?
    var createdAt: Date?

    enum CodingKeys: String, CodingKey {
        case id, value, note
        case assetId = "asset_id"
        case readingAt = "reading_at"
        case entryMethod = "entry_method"
        case correctionReason = "correction_reason"
        case usageSincePrevious = "usage_since_previous"
        case createdAt = "created_at"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        assetId = try c.decode(UUID.self, forKey: .assetId)
        readingAt = try c.decode(Date.self, forKey: .readingAt)
        entryMethod = try c.decodeIfPresent(String.self, forKey: .entryMethod)
        note = try c.decodeIfPresent(String.self, forKey: .note)
        correctionReason = try c.decodeIfPresent(String.self, forKey: .correctionReason)
        createdAt = try c.decodeIfPresent(Date.self, forKey: .createdAt)
        value = Self.decodeDecimal(c, key: .value) ?? 0
        usageSincePrevious = Self.decodeDecimal(c, key: .usageSincePrevious)
    }

    private static func decodeDecimal(_ c: KeyedDecodingContainer<CodingKeys>, key: CodingKeys) -> Double? {
        if let d = try? c.decodeIfPresent(Double.self, forKey: key) { return d }
        if let s = try? c.decodeIfPresent(String.self, forKey: key), let s, !s.isEmpty {
            return Double(s)
        }
        return nil
    }
}

struct MeterParseResult: Codable {
    var assetId: UUID
    var assetName: String?
    var value: Double
    var unit: String?
    var meterType: String?
    var confidence: Double?

    enum CodingKeys: String, CodingKey {
        case value, unit, confidence
        case assetId = "asset_id"
        case assetName = "asset_name"
        case meterType = "meter_type"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        assetId = try c.decode(UUID.self, forKey: .assetId)
        assetName = try c.decodeIfPresent(String.self, forKey: .assetName)
        unit = try c.decodeIfPresent(String.self, forKey: .unit)
        meterType = try c.decodeIfPresent(String.self, forKey: .meterType)
        confidence = try c.decodeIfPresent(Double.self, forKey: .confidence)
        if let d = try? c.decode(Double.self, forKey: .value) {
            value = d
        } else if let s = try? c.decode(String.self, forKey: .value), let d = Double(s) {
            value = d
        } else {
            value = 0
        }
    }
}

struct LowerReadingPreview: Codable {
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
