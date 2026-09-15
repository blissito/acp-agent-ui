#!/usr/bin/env python3
"""
Un MCP que genera voz con Kokoro, en Python puro (stdlib) y sin framework.

`generar_voz(texto, voz="em_santa", velocidad=1.0)` sintetiza con kokoro-onnx en CPU,
convierte a OGG/Opus con ffmpeg (WhatsApp lo entrega como nota de voz) y devuelve el
audio como bloque `audio` de MCP más un `text` con la ruta en /data/voz/<id>.ogg.

Transporte Streamable HTTP, el mismo contrato que mcp/imagen.ts:
  POST /mcp → JSON; notificación (sin id) → 202; GET → SSE con latido; DELETE → 200.

  python3 mcp/voz.py --http 4124

Variables: KOKORO_MODEL, KOKORO_VOICES (rutas a los modelos), VOZ_DIR (salida).

Prueba directa:
  curl -X POST localhost:4124/mcp -H 'content-type: application/json' \
       -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
"""
import base64
import json
import os
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL = os.environ.get("KOKORO_MODEL", "/data/kokoro/kokoro-v1.0.onnx")
VOICES = os.environ.get("KOKORO_VOICES", "/data/kokoro/voices-v1.0.bin")
VOZ_DIR = os.environ.get("VOZ_DIR", "/data/voz")
DEFAULT_VOICE = "em_santa"

TOOLS = [
    {
        "name": "generar_voz",
        "description": (
            "Convierte texto en voz (español) con Kokoro y devuelve una nota de voz OGG/Opus. "
            "Úsala siempre que te pidan audio, voz, narración o una nota de voz."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "texto": {"type": "string", "description": "Texto a leer, en español"},
                "voz": {"type": "string", "description": f"Voz de Kokoro (default {DEFAULT_VOICE})"},
                "velocidad": {"type": "number", "description": "Velocidad de habla (default 1.0)"},
            },
            "required": ["texto"],
        },
    }
]

# El modelo se carga una sola vez y bajo candado: la caja tiene un solo CPU.
_kokoro = None
_lock = threading.Lock()


def _motor():
    global _kokoro
    if _kokoro is None:
        from kokoro_onnx import Kokoro

        _kokoro = Kokoro(MODEL, VOICES)
    return _kokoro


def generar(texto: str, voz: str = DEFAULT_VOICE, velocidad: float = 1.0):
    """Sintetiza y devuelve (ruta_ogg, base64, segundos)."""
    import soundfile as sf

    os.makedirs(VOZ_DIR, exist_ok=True)
    id_ = uuid.uuid4().hex[:12]
    wav = os.path.join(VOZ_DIR, f"{id_}.wav")
    ogg = os.path.join(VOZ_DIR, f"{id_}.ogg")
    with _lock:
        samples, sr = _motor().create(texto, voice=voz, speed=velocidad, lang="es")
    sf.write(wav, samples, sr)
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", wav,
         "-c:a", "libopus", "-b:a", "32k", "-ac", "1", "-ar", "48000", ogg],
        check=True,
    )
    os.remove(wav)
    with open(ogg, "rb") as f:
        data = base64.b64encode(f.read()).decode()
    return ogg, data, len(samples) / sr


def atender(req: dict):
    """Atiende una petición; None si era notificación (sin id) y no se contesta."""
    id_ = req.get("id")
    if id_ is None:
        return None
    ok = lambda result: {"jsonrpc": "2.0", "id": id_, "result": result}
    metodo = req.get("method")
    params = req.get("params") or {}
    if metodo == "initialize":
        return ok({
            "protocolVersion": params.get("protocolVersion", "2025-03-26"),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "voz", "version": "1.0.0"},
        })
    if metodo == "ping":
        return ok({})
    if metodo == "tools/list":
        return ok({"tools": TOOLS})
    if metodo == "tools/call":
        if params.get("name") != "generar_voz":
            return {"jsonrpc": "2.0", "id": id_, "error": {"code": -32602, "message": f"no conozco la tool {params.get('name')}"}}
        args = params.get("arguments") or {}
        texto = str(args.get("texto") or "").strip()
        if not texto:
            return ok({"isError": True, "content": [{"type": "text", "text": "Falta el texto"}]})
        try:
            ruta, data, seg = generar(texto, str(args.get("voz") or DEFAULT_VOICE), float(args.get("velocidad") or 1.0))
            return ok({
                "content": [
                    {"type": "audio", "data": data, "mimeType": "audio/ogg"},
                    {"type": "text", "text": f"Nota de voz generada ({seg:.1f}s), archivo: {ruta}"},
                ],
            })
        except Exception as e:  # noqa: BLE001
            return ok({"isError": True, "content": [{"type": "text", "text": f"No pude generar la voz: {e}"}]})
    return {"jsonrpc": "2.0", "id": id_, "error": {"code": -32601, "message": f"no conozco {metodo}"}}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # un renglón por petición en stderr
        sys.stderr.write("[voz] %s\n" % (fmt % args))

    def _json(self, code, obj):
        cuerpo = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(cuerpo)))
        self.end_headers()
        self.wfile.write(cuerpo)

    def do_GET(self):
        if self.path.split("?")[0] != "/mcp":
            self.send_response(404); self.end_headers(); return
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self.send_header("connection", "keep-alive")
        self.end_headers()
        try:
            self.wfile.write(b": abierto\n\n"); self.wfile.flush()
            while True:
                time.sleep(15)
                self.wfile.write(b": ping\n\n"); self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_DELETE(self):
        self.send_response(200 if self.path.split("?")[0] == "/mcp" else 404)
        self.send_header("content-length", "0")
        self.end_headers()

    def do_POST(self):
        if self.path.split("?")[0] != "/mcp":
            self.send_response(404); self.send_header("content-length", "0"); self.end_headers(); return
        n = int(self.headers.get("content-length") or 0)
        cuerpo = self.rfile.read(n)
        try:
            msg = json.loads(cuerpo)
        except Exception:
            self._json(400, {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "JSON ilegible"}})
            return
        respuesta = atender(msg)
        if respuesta is None:
            self.send_response(202); self.send_header("content-length", "0"); self.end_headers(); return
        self._json(200, respuesta)


def servir_http(port: int):
    srv = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    sys.stderr.write(f"[voz] http://127.0.0.1:{port}/mcp\n")
    # Calentar el modelo en segundo plano para que la primera llamada no espere la carga.
    threading.Thread(target=lambda: _motor(), daemon=True).start()
    srv.serve_forever()


if __name__ == "__main__":
    port = 4124
    if "--http" in sys.argv:
        i = sys.argv.index("--http")
        if i + 1 < len(sys.argv) and sys.argv[i + 1].isdigit():
            port = int(sys.argv[i + 1])
    servir_http(port)
