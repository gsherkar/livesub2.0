
from functools import lru_cache
from faster_whisper import WhisperModel


@lru_cache(maxsize=1)
def get_model():
    return WhisperModel(
        "small",
        device="cpu",
        compute_type="int8",
    )


def transcribe_audio(file_path: str) -> dict:
    model = get_model()

    segments, info = model.transcribe(
        file_path,
        beam_size=1,
        vad_filter=True,
    )

    results = []

    for segment in segments:
        results.append({
            "text": segment.text.strip(),
            "start": round(segment.start, 3),
            "end": round(segment.end, 3),
        })

    return {
        "language": info.language,
        "segments": results,
    }
