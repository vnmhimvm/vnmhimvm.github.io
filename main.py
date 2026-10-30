import logging
import os
import time
from typing import Annotated, Literal

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from starlette.responses import JSONResponse

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("mini_brain_api")

MAX_BODY_BYTES = 64 * 1024
MAX_MESSAGES = 20
MAX_MESSAGE_CHARS = 12_000
MAX_REQUESTS_PER_MINUTE = 20
MessageText = Annotated[str, StringConstraints(min_length=1, max_length=MAX_MESSAGE_CHARS)]
requests_by_ip: dict[str, list[float]] = {}


class ChatMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: Literal["user", "assistant"]
    content: MessageText


class ChatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    messages: Annotated[list[ChatMessage], Field(min_length=1, max_length=MAX_MESSAGES)]


class ChatResponse(BaseModel):
    reply: str


app = FastAPI(title="Mini-brain API", docs_url=None, redoc_url=None)

allowed_origins = [
    origin.strip()
    for origin in os.getenv("ALLOWED_ORIGINS", "https://vnmhimvm.github.io").split(",")
    if origin.strip()
]
class BodySizeLimitMiddleware:
    def __init__(self, asgi_app, max_bytes: int):
        self.app = asgi_app
        self.max_bytes = max_bytes

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("method") != "POST":
            await self.app(scope, receive, send)
            return

        chunks = []
        size = 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            chunk = message.get("body", b"")
            size += len(chunk)
            if size > self.max_bytes:
                response = JSONResponse(
                    status_code=413,
                    content={"detail": "Запрос слишком большой. Сократите историю переписки."},
                )
                await response(scope, receive, send)
                return
            chunks.append(message)
            if not message.get("more_body", False):
                break

        iterator = iter(chunks)

        async def replay_body():
            try:
                return next(iterator)
            except StopIteration:
                return {"type": "http.disconnect"}

        await self.app(scope, replay_body, send)


app.add_middleware(BodySizeLimitMiddleware, max_bytes=MAX_BODY_BYTES)
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
    expose_headers=["Retry-After"],
)


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/api/chat", response_model=ChatResponse)
async def chat(payload: ChatRequest, request: Request):
    if not payload.messages:
        raise HTTPException(status_code=400, detail="Добавьте сообщение, чтобы начать диалог.")
    if len(payload.messages) > MAX_MESSAGES:
        raise HTTPException(status_code=400, detail=f"Можно отправить не более {MAX_MESSAGES} сообщений за раз.")
    if payload.messages[-1].role != "user":
        raise HTTPException(status_code=400, detail="Последнее сообщение должно быть от пользователя.")

    now = time.monotonic()
    client_ip = request.client.host if request.client else "unknown"
    recent_requests = [sent_at for sent_at in requests_by_ip.get(client_ip, []) if now - sent_at < 60]
    if len(recent_requests) >= MAX_REQUESTS_PER_MINUTE:
        retry_after = max(1, int(60 - (now - min(recent_requests)) + 0.999))
        raise HTTPException(
            status_code=429,
            detail="Слишком много запросов. Подождите немного и попробуйте ещё раз.",
            headers={"Retry-After": str(retry_after)},
        )
    requests_by_ip[client_ip] = [*recent_requests, now]
    if len(requests_by_ip) > 10_000:
        for ip, timestamps in list(requests_by_ip.items()):
            if not any(now - sent_at < 60 for sent_at in timestamps):
                requests_by_ip.pop(ip, None)
        while len(requests_by_ip) > 10_000:
            requests_by_ip.pop(next(iter(requests_by_ip)))

    api_key = os.getenv("OPENROUTER_API_KEY", "").strip()
    if not api_key:
        raise HTTPException(status_code=503, detail="ИИ-сервер ещё не настроен: добавьте ключ OpenRouter.")

    model = os.getenv("OPENROUTER_MODEL", "openrouter/free").strip()
    if not model or len(model) > 160:
        raise HTTPException(status_code=500, detail="На сервере задана некорректная модель.")
    origin = request.headers.get("origin", "")
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": origin or "https://vnmhimvm.github.io",
        "X-Title": "Mini-brain",
    }

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(75.0, connect=10.0)) as client:
            result = await client.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers=headers,
                json={
                    "model": model,
                    "messages": [message.model_dump() for message in payload.messages],
                },
            )
    except httpx.TimeoutException:
        logger.warning("OpenRouter request timed out")
        raise HTTPException(status_code=504, detail="ИИ-сервис долго не отвечает. Попробуйте ещё раз.") from None
    except httpx.RequestError as exc:
        logger.warning("OpenRouter request failed: %s", exc.__class__.__name__)
        raise HTTPException(status_code=502, detail="Не удалось связаться с ИИ-сервисом.") from None

    if result.is_error:
        logger.warning("OpenRouter returned HTTP %s", result.status_code)
        if result.status_code in (401, 403):
            raise HTTPException(status_code=502, detail="ИИ-сервис отклонил ключ или настройки модели.")
        if result.status_code == 429:
            raise HTTPException(status_code=503, detail="Сервис временно перегружен или исчерпан лимит. Попробуйте позже.")
        raise HTTPException(status_code=502, detail="ИИ-сервис не смог обработать запрос.")

    try:
        data = result.json()
        reply = data["choices"][0]["message"]["content"]
    except (ValueError, KeyError, IndexError, TypeError):
        logger.warning("OpenRouter returned an unexpected response")
        raise HTTPException(status_code=502, detail="ИИ-сервис вернул ответ в неизвестном формате.") from None
    if not isinstance(reply, str) or not reply.strip():
        raise HTTPException(status_code=502, detail="ИИ-сервис вернул пустой ответ.")
    return ChatResponse(reply=reply[:24_000])
