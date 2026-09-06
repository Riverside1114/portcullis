"""The sidecar the core talks to.

Newline delimited JSON over a loopback socket. Deliberately boring: the core
must be able to lose this process entirely and keep carrying traffic, so there
is no state to lose and nothing to recover.
"""

from __future__ import annotations

import json
import os
import secrets
import socket
import socketserver
import threading
from dataclasses import dataclass
from pathlib import Path

from . import __version__
from .detect import analyze
from .rules import Packs, load

#: A single message larger than this is refused rather than buffered.
MAX_MESSAGE_BYTES = 16 * 1024 * 1024


def portcullis_home() -> Path:
    override = os.environ.get("PORTCULLIS_HOME")
    return Path(override).resolve() if override else Path.home() / ".portcullis"


def endpoint_file() -> Path:
    return portcullis_home() / "run" / "analyzer.json"


@dataclass
class Endpoint:
    host: str
    port: int
    token: str

    def write(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "host": self.host,
            "port": self.port,
            "token": self.token,
            "pid": os.getpid(),
            "version": __version__,
        }
        # 0600 because the token is what stops another local process using the
        # analyzer as an oracle for what it will and will not flag.
        descriptor = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle)


class _Handler(socketserver.StreamRequestHandler):
    packs: Packs
    token: str

    def handle(self) -> None:
        for raw in self.rfile:
            if len(raw) > MAX_MESSAGE_BYTES:
                self._send({"ok": False, "error": "message too large"})
                return

            line = raw.decode("utf-8", errors="replace").strip()
            if not line:
                continue

            try:
                request = json.loads(line)
            except json.JSONDecodeError as error:
                self._send({"ok": False, "error": f"bad json: {error}"})
                continue

            self._send(self._dispatch(request))

    def _dispatch(self, request: dict) -> dict:
        identifier = request.get("id")

        if request.get("token") != self.token:
            return {"id": identifier, "ok": False, "error": "bad token"}

        op = request.get("op")

        if op == "ping":
            return {"id": identifier, "ok": True, "version": __version__}

        if op == "analyze":
            text = request.get("text")
            if not isinstance(text, str):
                return {"id": identifier, "ok": False, "error": "text must be a string"}
            try:
                result = analyze(text, self.packs)
            except Exception as error:  # noqa: BLE001
                # A rule that blows up must not take the sidecar down, or the
                # core loses inspection for the rest of the session.
                return {"id": identifier, "ok": False, "error": f"analysis failed: {error}"}
            return {"id": identifier, "ok": True, **result.as_dict()}

        return {"id": identifier, "ok": False, "error": f"unknown op {op!r}"}

    def _send(self, payload: dict) -> None:
        self.wfile.write((json.dumps(payload) + "\n").encode("utf-8"))
        self.wfile.flush()


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def serve(host: str = "127.0.0.1", port: int = 0, packs: Packs | None = None) -> None:
    """Runs until interrupted. Binds loopback only."""
    packs = packs if packs is not None else load()
    token = secrets.token_urlsafe(24)

    handler = type("Handler", (_Handler,), {"packs": packs, "token": token})
    server = Server((host, port), handler)

    bound_host, bound_port = server.server_address[0], server.server_address[1]
    endpoint = Endpoint(str(bound_host), int(bound_port), token)
    path = endpoint_file()
    endpoint.write(path)

    print(
        f"portcullis-analyzer {__version__} on {bound_host}:{bound_port}\n"
        f"  {len(packs.secrets)} secret rules, {len(packs.injection)} injection rules, "
        f"threshold {packs.threshold}\n"
        f"  endpoint written to {path}",
        flush=True,
    )

    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    try:
        thread.join()
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
        server.server_close()
        # Leaving a stale endpoint file behind would have the core connecting to
        # a port nothing is listening on.
        path.unlink(missing_ok=True)


def probe(timeout: float = 2.0) -> dict | None:
    """Checks whether a sidecar is up, for `portcullis-analyzer status`."""
    path = endpoint_file()
    if not path.exists():
        return None

    try:
        endpoint = json.loads(path.read_text(encoding="utf-8"))
        with socket.create_connection((endpoint["host"], endpoint["port"]), timeout) as sock:
            sock.sendall(
                (json.dumps({"op": "ping", "id": 1, "token": endpoint["token"]}) + "\n").encode()
            )
            reply = sock.makefile("r", encoding="utf-8").readline()
        return json.loads(reply)
    except (OSError, ValueError, KeyError):
        return None
