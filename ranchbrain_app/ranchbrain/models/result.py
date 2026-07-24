from dataclasses import dataclass, asdict
from typing import Literal
import json

ResultStatus = Literal["created", "duplicate", "ok", "error"]

@dataclass
class MemoryResult:
    status: ResultStatus
    path: str = ""
    memory_id: str = ""
    message: str = ""

    def to_dict(self):
        return asdict(self)

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), indent=2, ensure_ascii=False)

    @property
    def created(self) -> bool:
        return self.status == "created"

    @property
    def duplicate(self) -> bool:
        return self.status == "duplicate"
