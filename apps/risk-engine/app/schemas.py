"""Request / response contracts of the risk engine.

These are the only things the backend depends on, so the prototype model behind them
can be swapped for a trained ML model without touching any other service.
"""
from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class Condition(CamelModel):
    condition: str
    risk_category: str = "OTHER"


class PatientContext(CamelModel):
    id: Optional[str] = None
    age: int = Field(ge=0, le=130)
    conditions: list[Condition] = []


class Reading(CamelModel):
    timestamp: datetime
    heart_rate: Optional[float] = None
    spo2: Optional[float] = None
    temperature: Optional[float] = None
    systolic_bp: Optional[float] = None
    diastolic_bp: Optional[float] = None
    respiratory_rate: Optional[float] = None


class NoteSignal(CamelModel):
    signal: str
    timestamp: Optional[datetime] = None
    evidence: Optional[str] = None


class HistoryPoint(CamelModel):
    timestamp: datetime
    risk_score: int = Field(ge=0, le=100)


class EquipmentState(CamelModel):
    type: str
    status: str


class AssessRequest(CamelModel):
    patient: PatientContext
    readings: list[Reading] = Field(min_length=1, max_length=500)
    note_signals: list[NoteSignal] = []
    history: list[HistoryPoint] = []
    equipment: list[EquipmentState] = []


class Factor(CamelModel):
    factor: str
    category: Literal["VITAL_VALUE", "TREND", "COMBINED", "CONTEXT", "NOTE", "RECOVERY", "SAFETY_FLOOR"]
    points: int
    detail: str


class Prediction(CamelModel):
    window: str = "24-48 hours"
    current_risk: int
    previous_risk: Optional[int]
    velocity: int
    velocity_window: str
    trend: Literal["INCREASING", "STABLE", "DECREASING"]
    projected_risk: int
    projected_level: Literal["LOW", "MEDIUM", "HIGH"]
    statement: str
    disclaimer: str


class AssessResponse(CamelModel):
    risk_level: Literal["LOW", "MEDIUM", "HIGH"]
    risk_score: int
    confidence: float
    explanation: str
    reasons: list[str]
    contributing_factors: list[Factor]
    prediction_window: str = "24-48 hours"
    prediction: Prediction
    recommended_action: str
    engine_version: str


class ExtractRequest(CamelModel):
    text: str = Field(min_length=1, max_length=2000)


class ExtractedSignal(CamelModel):
    signal: str
    label: str
    evidence: str


class ExtractResponse(CamelModel):
    language: str
    translated_text: Optional[str]
    signals: list[ExtractedSignal]
    negated_signals: list[ExtractedSignal]
    method: str
