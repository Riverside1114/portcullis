"""Screenshots the real dashboard.

The promo animates actual screenshots rather than a recreation. A mock-up of
your own UI is the kind of thing people notice, and it goes stale the moment
the UI changes.
"""

from __future__ import annotations

import json
import socket
import subprocess
import tempfile
import time
from contextlib import closing
from pathlib import Path

from PIL import Image

from .capture import CLI, CORE, EXAMPLES, BuildRequired, _env

VIEWPORT = (1600, 1000)


def _free_port() -> int:
    with closing(socket.socket()) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _seed(home: Path) -> None:
    """Drives a gated session so the dashboard has a policy story to show."""
    requests = []
    identifier = 0

    for path in [
        "/home/me/project/src/app.ts",
        "/home/me/project/src/server.ts",
        "/home/me/project/package.json",
        "/home/me/project/README.md",
    ] * 3:
        identifier += 1
        requests.append(
            {
                "jsonrpc": "2.0",
                "id": identifier,
                "method": "tools/call",
                "params": {"name": "read_file", "arguments": {"path": path}},
            }
        )

    for path in ["/home/me/.env", "/home/me/.ssh/id_rsa", "/home/me/.aws/credentials"]:
        identifier += 1
        requests.append(
            {
                "jsonrpc": "2.0",
                "id": identifier,
                "method": "tools/call",
                "params": {"name": "read_file", "arguments": {"path": path}},
            }
        )

    for method in ["tools/list", "resources/list", "prompts/list"]:
        identifier += 1
        requests.append({"jsonrpc": "2.0", "id": identifier, "method": method})

    identifier += 1
    requests.append({"jsonrpc": "2.0", "id": identifier, "method": "quit", "params": {"code": 0}})

    subprocess.run(
        [
            "node", str(CLI), "run",
            "--name", "filesystem",
            "--policy", str(EXAMPLES / "filesystem.yaml"),
            "--quiet",
            "--",
            "node", str(CORE / "fixtures" / "echo-server.mjs"),
        ],
        cwd=CORE,
        env=_env(home),
        input="\n".join(json.dumps(r) for r in requests) + "\n",
        capture_output=True,
        text=True,
        timeout=120,
    )


def screenshots(out_dir: Path) -> dict[str, Image.Image]:
    """Returns the dashboard views the film uses, as real screenshots."""
    if not CLI.exists():
        raise BuildRequired(f"{CLI} is missing. Build the core first.")

    from playwright.sync_api import sync_playwright

    out_dir.mkdir(parents=True, exist_ok=True)
    home = Path(tempfile.mkdtemp(prefix="portcullis-shots-"))
    _seed(home)

    port = _free_port()
    server = subprocess.Popen(
        ["node", str(CLI), "serve", "--port", str(port), "--quiet"],
        cwd=CORE,
        env=_env(home),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    shots: dict[str, Image.Image] = {}
    try:
        _wait_for(port)

        with sync_playwright() as play:
            browser = play.chromium.launch()
            page = browser.new_page(
                viewport={"width": VIEWPORT[0], "height": VIEWPORT[1]},
                device_scale_factor=1,
                color_scheme="dark",
            )
            page.goto(f"http://127.0.0.1:{port}/", wait_until="networkidle")
            page.wait_for_selector("#rows tr", timeout=15000)
            page.wait_for_timeout(500)

            shots["overview"] = _shot(page, out_dir / "dashboard-overview.png")

            # Narrowed to the denials, which is the view worth showing.
            page.select_option("#verdict", "deny")
            page.wait_for_timeout(700)
            shots["denied"] = _shot(page, out_dir / "dashboard-denied.png")

            page.select_option("#verdict", "")
            page.wait_for_timeout(500)
            row = page.query_selector("#rows tr.denied") or page.query_selector("#rows tr")
            if row:
                row.click()
                page.wait_for_timeout(600)
            shots["detail"] = _shot(page, out_dir / "dashboard-detail.png")

            browser.close()
    finally:
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()

    return shots


def _shot(page, path: Path) -> Image.Image:
    page.screenshot(path=str(path))
    return Image.open(path).convert("RGB")


def _wait_for(port: int, timeout: float = 20.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        with closing(socket.socket()) as sock:
            sock.settimeout(0.4)
            if sock.connect_ex(("127.0.0.1", port)) == 0:
                return
        time.sleep(0.2)
    raise RuntimeError(f"the dashboard did not start on port {port}")
