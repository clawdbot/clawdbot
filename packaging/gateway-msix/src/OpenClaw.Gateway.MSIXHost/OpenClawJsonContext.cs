using System.Text.Json.Serialization;

namespace OpenClaw.MSIXHost;

[JsonSerializable(typeof(PayloadMetadata))]
[JsonSerializable(typeof(PayloadInventory))]
internal sealed partial class OpenClawJsonContext : JsonSerializerContext;
