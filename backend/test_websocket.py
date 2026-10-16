
import asyncio
import json
from websockets.asyncio.client import connect


async def main():
    uri = "ws://127.0.0.1:8000/ws"

    async with connect(uri) as ws:
        print("SERVER:", await ws.recv())

        # Simulate a provisional transcript from Member 2
        await ws.send(json.dumps({
            "type": "transcript",
            "segment_id": "demo-001",
            "text": "Hola, ¿cómo estás?",
            "start": 1.2,
            "end": 2.4,
            "status": "provisional",
            "source_lang": "auto",
            "target_lang": "en"
        }))

        print("PROVISIONAL RESULT:")
        print(json.dumps(
            json.loads(await ws.recv()),
            indent=2,
            ensure_ascii=False
        ))

        # Simulate the corrected, final transcript
        await ws.send(json.dumps({
            "type": "transcript",
            "segment_id": "demo-001",
            "text": "Hola, ¿cómo estás?",
            "start": 1.2,
            "end": 2.4,
            "status": "final",
            "source_lang": "auto",
            "target_lang": "en"
        }))

        print("FINAL RESULT:")
        print(json.dumps(
            json.loads(await ws.recv()),
            indent=2,
            ensure_ascii=False
        ))


asyncio.run(main())
