#!/usr/bin/env python3
"""
Oído de la caja: transcribe voz a texto con faster-whisper, en Python puro (stdlib) y sin framework.

No es un MCP: es un servicio HTTP para el canal de WhatsApp (las notas de voz que llegan).

  POST /transcribe?lang=es   cuerpo = bytes del audio (ogg/opus, mp3, m4a, wav… lo que lea ffmpeg)
                             → {"text": "...", "duration": segundos_de_audio, "language": "es", "took": segundos}
  GET  /health               → {"ok": true, "model": "base"}

ffmpeg convierte a wav 16 kHz mono; faster-whisper (CTranslate2, int8, CPU) transcribe.
El modelo se carga una sola vez al arrancar y un candado evita dos transcripciones a la vez
(la caja tiene un solo CPU).

  python3 mcp/oido.py --http 4125

Variables: WHISPER_MODEL (base|small|…), WHISPER_THREADS, HF_HOME (dónde queda el modelo), OIDO_DIR (temporales).
"""
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

MODEL_NAME = os.environ.get("WHISPER_MODEL", "base")
THREADS = int(os.environ.get("WHISPER_THREADS", "1"))
OIDO_DIR = os.environ.get("OIDO_DIR", "/data/oido")
DEFAULT_LANG = "es"

_model = None
_lock = threading.Lock()


def _motor():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel

        _model = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8", cpu_threads=THREADS)
    return _model


def transcribir(audio: bytes, lang: str = DEFAULT_LANG) -> dict:
    """Convierte a wav 16k mono con ffmpeg y transcribe. Devuelve text/duration/language/took."""
    os.makedirs(OIDO_DIR, exist_ok=True)
    fd, wav = tempfile.mkstemp(suffix=".wav", dir=OIDO_DIR)
    os.close(fd)
    t0 = time.time()
    try:
        # ffmpeg lee de stdin: no hace falta saber el formato de entrada
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", "pipe:0",
             "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav],
            input=audio, check=True, capture_output=True,
        )
        with _lock:
            segments, info = _motor().transcribe(
                wav, language=lang or None, beam_size=1, vad_filter=True,
                condition_on_previous_text=False,
            )
            text = " ".join(s.text.strip() for s in segments if s.text.strip())
        return {
            "text": text,
            "duration": round(info.duration, 2),
            "language": info.language,
            "took": round(time.time() - t0, 2),
        }
    finally:
        try:
            os.remove(wav)
        except OSError:
            pass


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # un renglón por petición en stderr
        sys.stderr.write("[oido] %s\n" % (fmt % args))

    def _json(self, code, obj):
        cuerpo = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(cuerpo)))
        self.end_headers()
        self.wfile.write(cuerpo)

    def do_GET(self):
        if urlparse(self.path).path != "/health":
            self.send_response(404); self.send_header("content-length", "0"); self.end_headers(); return
        self._json(200, {"ok": _model is not None, "model": MODEL_NAME, "loading": _model is None})

    def do_POST(self):
        url = urlparse(self.path)
        if url.path != "/transcribe":
            self.send_response(404); self.send_header("content-length", "0"); self.end_headers(); return
        n = int(self.headers.get("content-length") or 0)
        audio = self.rfile.read(n)
        if not audio:
            self._json(400, {"error": "cuerpo vacío: manda los bytes del audio"})
            return
        lang = (parse_qs(url.query).get("lang") or [DEFAULT_LANG])[0]
        try:
            self._json(200, transcribir(audio, lang))
        except subprocess.CalledProcessError as e:
            self._json(400, {"error": "ffmpeg no pudo leer el audio", "detail": e.stderr.decode(errors="replace")[-300:]})
        except Exception as e:  # noqa: BLE001
            self._json(500, {"error": f"no pude transcribir: {e}"})


def servir_http(port: int):
    srv = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    sys.stderr.write(f"[oido] http://127.0.0.1:{port}/transcribe (modelo {MODEL_NAME})\n")
    # Calentar el modelo en segundo plano para que la primera nota no espere la carga.
    threading.Thread(target=lambda: _motor(), daemon=True).start()
    srv.serve_forever()


if __name__ == "__main__":
    port = 4125
    if "--http" in sys.argv:
        i = sys.argv.index("--http")
        if i + 1 < len(sys.argv) and sys.argv[i + 1].isdigit():
            port = int(sys.argv[i + 1])
    servir_http(port)
