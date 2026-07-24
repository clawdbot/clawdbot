from dataclasses import dataclass, asdict
from typing import Literal
import json

RelationshipType = Literal[
    "related",
    "caused_by",
    "follow_up",
    "duplicate_of",
    "references",
    "contains",
    "located_at",
    "parent",
    "child",
]

@dataclass
class MemoryRelationship:
    target_id: str
    relationship_type: RelationshipType = "related"
    note: str = ""

    def to_dict(self):
        return asdict(self)

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), indent=2, ensure_ascii=False)
