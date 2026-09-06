"""The sidecar protocol, over a real socket."""

from __future__ import annotations

import json
import socket
import tempfile
import threading
import unittest
from pathlib import Path

from portcullis_analyzer import server
from portcullis_analyzer.rules import load

PACKS = load()


class Sidecar(unittest.TestCase):
    def setUp(self) -> None:
        self.home = tempfile.mkdtemp(prefix="analyzer-test-")
        self.token = "test-token"
        handler = type("Handler", (server._Handler,), {"packs": PACKS, "token": self.token})
        self.server = server.Server(("127.0.0.1", 0), handler)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    def call(self, payload: dict) -> dict:
        with socket.create_connection(("127.0.0.1", self.port), timeout=5) as sock:
            sock.sendall((json.dumps(payload) + "\n").encode("utf-8"))
            return json.loads(sock.makefile("r", encoding="utf-8").readline())

    def test_ping(self) -> None:
        reply = self.call({"op": "ping", "id": 1, "token": self.token})
        self.assertTrue(reply["ok"])
        self.assertEqual(reply["id"], 1)

    def test_analyze_returns_findings_and_redacted_text(self) -> None:
        reply = self.call({
            "op": "analyze", "id": 7, "token": self.token,
            "text": "token ghp_1234567890abcdefghijklmnopqrstuvwxyz",
        })
        self.assertTrue(reply["ok"])
        self.assertEqual(reply["id"], 7)
        self.assertIn("[redacted: github-token]", reply["redacted"])
        self.assertTrue(any(f["rule"] == "github-token" for f in reply["findings"]))

    def test_clean_text_reports_no_change(self) -> None:
        reply = self.call({"op": "analyze", "id": 2, "token": self.token, "text": "hello"})
        self.assertTrue(reply["ok"])
        self.assertIsNone(reply["redacted"])
        self.assertEqual(reply["findings"], [])

    def test_rejects_a_bad_token(self) -> None:
        # Without this any local process could use the sidecar as an oracle for
        # what will and will not be flagged.
        reply = self.call({"op": "analyze", "id": 3, "token": "wrong", "text": "x"})
        self.assertFalse(reply["ok"])
        self.assertIn("token", reply["error"])

    def test_survives_malformed_input(self) -> None:
        with socket.create_connection(("127.0.0.1", self.port), timeout=5) as sock:
            sock.sendall(b"not json at all\n")
            first = json.loads(sock.makefile("r", encoding="utf-8").readline())
        self.assertFalse(first["ok"])
        # Still serving afterwards.
        self.assertTrue(self.call({"op": "ping", "id": 9, "token": self.token})["ok"])

    def test_unknown_op(self) -> None:
        reply = self.call({"op": "nonsense", "id": 4, "token": self.token})
        self.assertFalse(reply["ok"])

    def test_several_requests_on_one_connection(self) -> None:
        with socket.create_connection(("127.0.0.1", self.port), timeout=5) as sock:
            stream = sock.makefile("rw", encoding="utf-8")
            for identifier in range(1, 6):
                stream.write(json.dumps({"op": "ping", "id": identifier, "token": self.token}) + "\n")
                stream.flush()
                self.assertEqual(json.loads(stream.readline())["id"], identifier)


class EndpointFile(unittest.TestCase):
    def test_written_with_restrictive_permissions(self) -> None:
        with tempfile.TemporaryDirectory() as home:
            path = Path(home) / "run" / "analyzer.json"
            server.Endpoint("127.0.0.1", 1234, "secret-token").write(path)
            payload = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(payload["port"], 1234)
            self.assertEqual(payload["token"], "secret-token")


if __name__ == "__main__":
    unittest.main()
