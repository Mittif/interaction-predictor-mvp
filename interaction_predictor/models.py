from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class BBox(BaseModel):
    x1: float
    y1: float
    x2: float
    y2: float

    @property
    def width(self) -> float:
        return max(0.0, self.x2 - self.x1)

    @property
    def height(self) -> float:
        return max(0.0, self.y2 - self.y1)

    @property
    def area(self) -> float:
        return self.width * self.height


class DetectedObject(BaseModel):
    timestamp: str
    label: str
    display_name: str | None = None
    confidence: float
    bbox: BBox
    center_score: float
    interest_score: float
    is_interest_object: bool = False
    area_ratio: float
    tracking_id: str | None = None
    observed_duration_ms: int = 0


class SceneEntity(BaseModel):
    name: str
    category: str | None = None
    location: str | None = None
    confidence: float | None = None


class SceneGuess(BaseModel):
    type: str
    confidence: float = Field(ge=0, le=1)
    description: str


class SceneObservation(BaseModel):
    id: str
    timestamp: str
    source: str
    mode: str
    scene_guess: SceneGuess
    main_entities: list[SceneEntity] = Field(default_factory=list)
    lighting: str | None = None
    activity_hint: str | None = None
    uncertainty: str | None = None
    raw_llm_output: dict[str, Any] = Field(default_factory=dict)


class PossibleInteraction(BaseModel):
    rank: int
    action: str
    reason: str
    confidence: float = Field(ge=0, le=1)


class InteractionPrediction(BaseModel):
    id: str
    timestamp: str
    scene: dict[str, Any]
    scene_objects: list[str]
    interest_object: dict[str, Any]
    possible_interactions: list[PossibleInteraction]
    raw_llm_output: dict[str, Any] = Field(default_factory=dict)

