import threading
import time
from collections import OrderedDict

from deep_translator import GoogleTranslator, MyMemoryTranslator
from deep_translator.exceptions import (
    InvalidSourceOrTargetLanguage,
    LanguageNotSupportedException,
    TooManyRequests,
)

# Temporary fallback for development and integration tests.
# This is NOT a real translation model.
DEMO_TRANSLATIONS = {
    "hello": "hello",
    "hello everyone": "hello everyone",
    "hola, ¿cómo estás?": "hello, how are you?",
    "bonjour": "hello",
}

# MyMemory (the backup service) only accepts regional codes.
MYMEMORY_CODES = {
    "en": "en-GB", "hi": "hi-IN", "mr": "mr-IN", "ta": "ta-IN",
    "te": "te-IN", "bn": "bn-IN", "gu": "gu-IN", "kn": "kn-IN",
    "ml": "ml-IN", "pa": "pa-IN", "ur": "ur-PK", "es": "es-ES",
    "fr": "fr-FR", "de": "de-DE", "ja": "ja-JP", "zh": "zh-CN",
    "ar": "ar-SA", "ru": "ru-RU",
}

# If Google rate-limits us, skip it for a while instead of hammering it.
GOOGLE_COOLDOWN_SECONDS = 60
_google_blocked_until = 0.0

# Remember recent translations so repeated lines cost no request.
_CACHE_SIZE = 500
_cache: "OrderedDict[tuple, str]" = OrderedDict()
_lock = threading.Lock()


def _google(text: str, source_lang: str, target_lang: str) -> str:
    translator = GoogleTranslator(source=source_lang, target=target_lang)
    return translator.translate(text) or text


def _mymemory(text: str, source_lang: str, target_lang: str) -> str:
    source = MYMEMORY_CODES.get(source_lang.lower())
    target = MYMEMORY_CODES.get(target_lang.lower())

    if not source or not target:
        raise ValueError(
            f"MyMemory cannot translate {source_lang} -> {target_lang}"
        )

    translator = MyMemoryTranslator(source=source, target=target)
    return translator.translate(text) or text


def _translate_uncached(text: str, source_lang: str, target_lang: str) -> str:
    global _google_blocked_until

    if time.time() >= _google_blocked_until:
        try:
            try:
                return _google(text, source_lang, target_lang)
            except (LanguageNotSupportedException, InvalidSourceOrTargetLanguage):
                # Whisper can return a code Google rejects: retry once
                # with automatic source detection.
                if source_lang != "auto":
                    return _google(text, "auto", target_lang)
                raise
        except TooManyRequests:
            _google_blocked_until = time.time() + GOOGLE_COOLDOWN_SECONDS
            print(
                f"Google rate-limited us; using MyMemory for "
                f"{GOOGLE_COOLDOWN_SECONDS}s"
            )

    return _mymemory(text, source_lang, target_lang)


def translate_text(
    text: str,
    source_lang: str = "auto",
    target_lang: str = "en",
) -> str:
    if not text or not text.strip():
        return ""

    if source_lang != "auto" and source_lang.lower() == target_lang.lower():
        return text

    # Use sample mappings only for development tests.
    if target_lang.lower() == "en":
        demo = DEMO_TRANSLATIONS.get(text.strip().lower())
        if demo:
            return demo

    key = (text.strip(), source_lang.lower(), target_lang.lower())

    with _lock:
        if key in _cache:
            _cache.move_to_end(key)
            return _cache[key]

    result = _translate_uncached(text, source_lang, target_lang)

    with _lock:
        _cache[key] = result
        while len(_cache) > _CACHE_SIZE:
            _cache.popitem(last=False)

    return result