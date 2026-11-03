#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import sys
import time
import wave

from vosk import KaldiRecognizer, Model, SetLogLevel


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio")
    parser.add_argument("--model", required=True)
    parser.add_argument("--mode", choices=("dictation", "wake"))
    parser.add_argument("--agent-name", default="")
    parser.add_argument("--server", action="store_true")
    args = parser.parse_args()

    if not args.server and (not args.audio or not args.mode):
        parser.error("--audio and --mode are required unless --server is specified")
    SetLogLevel(-1)
    model = Model(args.model)
    if args.server:
        serve(model)
        return 0
    print(json.dumps(transcribe(args.audio, args.mode, args.agent_name, model)))
    return 0


def serve(model: Model) -> None:
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        request_id = None
        try:
            request = json.loads(line)
            request_id = request["requestId"]
            result = transcribe(
                request["audio"],
                request["mode"],
                request.get("agentName", ""),
                model,
            )
            response = {"requestId": request_id, **result}
        except Exception as error:
            response = {"requestId": request_id, "error": str(error)}
        print(json.dumps(response), flush=True)


def transcribe(audio_path: str, mode: str, agent_name: str, model: Model) -> dict:
    if mode not in ("dictation", "wake"):
        raise ValueError("mode must be dictation or wake")
    if mode == "wake" and not re.sub(r"[^\w]+", "", agent_name, flags=re.UNICODE):
        raise ValueError("wake recognition requires the active agent profile name")

    started = time.perf_counter()
    texts: list[str] = []
    confidences: list[float] = []
    with wave.open(audio_path, "rb") as audio:
        if audio.getnchannels() != 1 or audio.getsampwidth() != 2 or audio.getcomptype() != "NONE":
            raise ValueError("audio must be mono 16-bit PCM WAV")
        sample_rate = audio.getframerate()
        if sample_rate <= 0:
            raise ValueError("audio sample rate must be positive")

        recognizer = KaldiRecognizer(model, sample_rate)
        recognizer.SetWords(True)
        while chunk := audio.readframes(4_000):
            if recognizer.AcceptWaveform(chunk):
                collect_result(recognizer.Result(), texts, confidences)
        collect_result(recognizer.FinalResult(), texts, confidences)
        duration = audio.getnframes() / sample_rate

    text = " ".join(part for part in texts if part).strip()
    return {
        "text": text,
        "language": "en-US",
        "duration": duration,
        "processingTime": time.perf_counter() - started,
        "confidence": sum(confidences) / len(confidences) if confidences else None,
        "isEmpty": not text,
    }


def collect_result(payload: str, texts: list[str], confidences: list[float]) -> None:
    result = json.loads(payload)
    text = result.get("text", "").strip()
    if text:
        texts.append(text)
    for word in result.get("result", []):
        confidence = word.get("conf")
        if isinstance(confidence, (int, float)):
            confidences.append(float(confidence))


if __name__ == "__main__":
    raise SystemExit(main())
