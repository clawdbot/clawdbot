from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import List, Literal
from .reference import Reference
from .relationship import MemoryRelationship
import hashlib
import json

MemoryType = Literal["fact", "event", "observation", "decision", "document"]
PrivacyLevel = Literal["public", "private", "sensitive"]

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

@dataclass
class Memory:
    module: str
    category: str
    title: str
    body: str
    memory_type: MemoryType = "document"
    tags: List[str] = field(default_factory=list)
    references: List[Reference] = field(default_factory=list)
    relationships: List[MemoryRelationship] = field(default_factory=list)
    source_type: str = "manual"
    source_path: str = ""
    confidence: float = 1.0
    privacy_level: PrivacyLevel = "private"
    created_at: str = field(default_factory=now_iso)
    updated_at: str = field(default_factory=now_iso)
    id: str = ""

    def __post_init__(self):
        if not self.id:
            seed = f"{self.module}|{self.category}|{self.title}|{self.body}|{self.created_at}"
            self.id = hashlib.sha256(seed.encode("utf-8")).hexdigest()[:16]

    def to_dict(self):
        data = asdict(self)
        data["references"] = [
            r.to_dict() if hasattr(r, "to_dict") else r
            for r in self.references
        ]
        data["relationships"] = [
            r.to_dict() if hasattr(r, "to_dict") else r
            for r in self.relationships
        ]
        return data

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), indent=2, ensure_ascii=False)

    @staticmethod
    def from_dict(data: dict) -> "Memory":
        refs = data.get("references", [])
        rels = data.get("relationships", [])
        data = dict(data)
        data["references"] = [
            r if isinstance(r, Reference) else Reference(**r)
            for r in refs
        ]
        data["relationships"] = [
            r if isinstance(r, MemoryRelationship) else MemoryRelationship(**r)
            for r in rels
        ]
        return Memory(**data)
