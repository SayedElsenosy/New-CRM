"""Optional local shadow API, NOT a production WhatsApp/CRM endpoint.

Start only with AI_SHADOW_TOKEN configured; no database credentials or outgoing
messages. Connect production ONLY after separate auth, privacy and load review.
"""
import hmac
import os

try:
    from fastapi import FastAPI, Header, HTTPException, Request
except ImportError as exc:
    raise RuntimeError("pip install -r requirements.txt before starting API") from exc

from .core import plan

TOKEN = os.environ.get("AI_SHADOW_TOKEN", "")
if len(TOKEN) < 32:
    raise RuntimeError("AI_SHADOW_TOKEN must be set to a secret of 32+ characters")

app = FastAPI(title="SET CRM Python Shadow AI", docs_url=None, redoc_url=None,
              openapi_url=None)

@app.get("/healthz")
def health():
    return {"status": "shadow_only", "writes_enabled": False}

@app.post("/v1/plan")
async def shadow_plan(request: Request, x_ai_shadow_token: str = Header(default="")):
    if not hmac.compare_digest(x_ai_shadow_token, TOKEN):
        raise HTTPException(status_code=401, detail="Unauthorized")
    if int(request.headers.get("content-length", "0") or "0") > 1_000_000:
        raise HTTPException(status_code=413, detail="Payload too large")
    body = await request.body()
    if len(body) > 1_000_000:
        raise HTTPException(status_code=413, detail="Payload too large")
    try:
        import json
        payload = json.loads(body)
        return plan(payload)
    except (ValueError, TypeError, json.JSONDecodeError):
        raise HTTPException(status_code=422, detail="Invalid planner input") from None
