import asyncio
import time
import traceback
from contextlib import asynccontextmanager
from pathlib import Path
from tempfile import NamedTemporaryFile

from fastapi import FastAPI, File, HTTPException, UploadFile, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from metrics import log_event
from translation import translate_text


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Load the Whisper model in the background at startup so the first
    # audio chunk doesn't wait for the model download and load.
    async def warm_up():
        try:
            from transcription import get_model

            await asyncio.to_thread(get_model)
            print("Whisper model loaded.")
        except Exception as exc:
            print("Whisper preload failed:", repr(exc))

    warm_up_task = asyncio.create_task(warm_up())
    yield
    warm_up_task.cancel()


app = FastAPI(title="NOVARQ LiveSub Backend", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class TranslationRequest(BaseModel):
    text: str = Field(min_length=1, max_length=5000)
    source_lang: str = "auto"
    target_lang: str = "en"


@app.get("/")
def home():
    return {
        "project": "NOVARQ LiveSub",
        "status": "running",
    }


@app.get("/health")
def health():
    return {"status": "healthy"}


@app.post("/translate")
async def translate(request: TranslationRequest):
    started = time.perf_counter()

    try:
        translated = await asyncio.to_thread(
            translate_text,
            request.text,
            request.source_lang,
            request.target_lang,
        )

        latency_ms = round((time.perf_counter() - started) * 1000, 2)

        log_event({
            "type": "translation",
            "latency_ms": latency_ms,
            "status": "success",
        })

        return {
            "original_text": request.text,
            "translated_text": translated,
            "source_lang": request.source_lang,
            "target_lang": request.target_lang,
            "latency_ms": latency_ms,
        }

    except Exception as exc:
        print("TRANSLATION ERROR:", repr(exc))

        log_event({
            "type": "translation",
            "status": "error",
            "error": repr(exc),
        })

        raise HTTPException(
            status_code=502,
            detail=f"Translation failed: {type(exc).__name__}: {exc}",
        ) from exc


@app.websocket("/ws")
async def subtitle_socket(ws: WebSocket):
    await ws.accept()

    await ws.send_json({
        "type": "connected",
        "message": "NOVARQ subtitle backend ready"
    })

    try:
        while True:
            event = await ws.receive_json()

            if event.get("type") != "transcript":
                await ws.send_json({
                    "type": "error",
                    "message": "Expected transcript event"
                })
                continue

            text = event.get("text", "")

            if not isinstance(text, str) or not text.strip():
                await ws.send_json({
                    "type": "error",
                    "message": "Transcript text is required"
                })
                continue

            if len(text) > 5000:
                await ws.send_json({
                    "type": "error",
                    "message": "Transcript is too long"
                })
                continue

            try:
                start = float(event.get("start", 0))
                end = float(event.get("end", start))

                if start < 0 or end < start:
                    raise ValueError("Invalid timestamps")

            except (TypeError, ValueError):
                await ws.send_json({
                    "type": "error",
                    "message": "Invalid timestamps"
                })
                continue

            status = event.get("status", "final")

            if status not in ("provisional", "final"):
                await ws.send_json({
                    "type": "error",
                    "message": "Invalid subtitle status"
                })
                continue

            segment_id = str(event.get("segment_id", "segment-1"))
            source_lang = event.get("source_lang", "auto")
            target_lang = event.get("target_lang", "en")

            started = time.perf_counter()

            try:
                translated = await asyncio.to_thread(
                    translate_text,
                    text,
                    source_lang,
                    target_lang
                )

                latency_ms = round((time.perf_counter() - started) * 1000, 2)

                result = {
                    "type": "subtitle_result",
                    "segment_id": segment_id,
                    "original_text": text,
                    "translated_text": translated,
                    "start": start,
                    "end": end,
                    "status": status,
                    "source_lang": source_lang,
                    "target_lang": target_lang,
                    "latency_ms": latency_ms
                }

                await ws.send_json(result)

                log_event({
                    "type": "subtitle_processed",
                    **result
                })

            except Exception as exc:
                log_event({
                    "type": "subtitle_error",
                    "segment_id": segment_id,
                    "error": repr(exc)
                })

                await ws.send_json({
                    "type": "error",
                    "segment_id": segment_id,
                    "message": "Translation failed"
                })

    except Exception:
        try:
            await ws.close()
        except Exception:
            pass


@app.post("/transcribe-file")
async def transcribe_file(file: UploadFile = File(...)):
    temp_path = None
    started = time.perf_counter()

    try:
        content = await file.read()

        if not content:
            raise HTTPException(
                status_code=400,
                detail="The uploaded audio file is empty",
            )

        if len(content) > 25 * 1024 * 1024:
            raise HTTPException(
                status_code=413,
                detail="Audio file must be 25 MB or smaller",
            )

        # Preserve the file extension for audio decoding.
        suffix = Path(file.filename or "audio.wav").suffix or ".wav"

        with NamedTemporaryFile(suffix=suffix, delete=False) as temp:
            temp.write(content)
            temp_path = temp.name

        # Import only when the endpoint is used.
        from transcription import transcribe_audio

        result = await asyncio.to_thread(transcribe_audio, temp_path)

        latency_ms = round((time.perf_counter() - started) * 1000, 2)

        log_event({
            "type": "transcription",
            "status": "success",
            "latency_ms": latency_ms,
            "segment_count": len(result["segments"]),
        })

        return {
            **result,
            "latency_ms": latency_ms,
        }

    except HTTPException:
        raise

    except Exception as exc:
        print("TRANSCRIPTION ERROR:", repr(exc))
        traceback.print_exc()

        log_event({
            "type": "transcription",
            "status": "error",
            "error": repr(exc),
        })

        raise HTTPException(
            status_code=500,
            detail=f"Transcription failed: {type(exc).__name__}: {exc}",
        ) from exc

    finally:
        if temp_path:
            Path(temp_path).unlink(missing_ok=True)

        await file.close()