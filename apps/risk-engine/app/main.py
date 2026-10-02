"""Risk engine service (FastAPI).

POST /v1/assess          vitals + context + note signals -> explainable risk
POST /v1/notes/extract   caregiver note text -> structured signals
GET  /health
"""
import logging
import os
import time

from fastapi import FastAPI, Request

from .engine import notes
from .engine.model import get_model
from .schemas import AssessRequest, AssessResponse, ExtractRequest, ExtractResponse

logging.basicConfig(level=logging.INFO, format='{"level":"%(levelname)s","msg":%(message)s}')
log = logging.getLogger("risk-engine")

model = get_model(os.getenv("RISK_MODEL"))
app = FastAPI(title="Home-Care Risk Engine", version="1.0.0",
              description="Prototype explainable risk scoring. Not a medical device.")


@app.middleware("http")
async def timing(request: Request, call_next):
    started = time.perf_counter()
    response = await call_next(request)
    ms = round((time.perf_counter() - started) * 1000, 1)
    log.info('"%s %s","status":%s,"processing_ms":%s,"request_id":"%s"', request.method, request.url.path,
             response.status_code, ms, request.headers.get("x-request-id", "-"))
    return response


@app.get("/health")
def health():
    return {"status": "ok", "model": model.name}


@app.post("/v1/assess", response_model=AssessResponse, response_model_by_alias=True)
def assess(req: AssessRequest):
    return model.assess(req)


@app.post("/v1/notes/extract", response_model=ExtractResponse, response_model_by_alias=True)
def extract(req: ExtractRequest):
    return notes.extract(req.text)
