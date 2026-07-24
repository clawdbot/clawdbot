from dataclasses import dataclass, asdict
from typing import Literal
import json

ReferenceType = Literal["url", "file", "command", "memory", "photo", "pdf", "repo"]

@dataclass
class Reference:
    type: ReferenceType
    value: str
    title: str = ""
    confidence: float = 1.0

    def to_dict(self):
        return asdict(self)

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), indent=2, ensure_ascii=False)
