"""HTTP-сервер WtS: API массовой загрузки и отдача сайта MeteoLab Lite.

Только стандартная библиотека: ThreadingHTTPServer + json + zipfile. Сервер
слушает loopback по умолчанию, отдаёт те же файлы сайта, что и раньше, и
добавляет API /api/wts/*. Каталог результатов не публикуется: скачать файл
можно лишь по идентификатору задачи и относительному пути внутри неё.
"""

from __future__ import annotations

import json
import mimetypes
import os
import re
import urllib.parse
import urllib.request
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional

from . import __version__, planner
from .jobs import JobManager, ValidationPathError

MAX_BODY = 64 * 1024
STATIC_FILES = {
    "/": "meteolab-lite.html",
    "/index.html": "meteolab-lite.html",
    "/meteolab-lite.html": "meteolab-lite.html",
}
STATIC_DIRS = ("/src/",)
STATIC_EXT = {".html", ".css", ".js", ".json", ".png", ".svg", ".ico", ".woff2", ".txt"}


class WtsServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, manager: JobManager, site_dir: Path, quiet: bool = False):
        super().__init__(address, WtsHandler)
        self.manager = manager
        self.site_dir = Path(site_dir).resolve()
        self.quiet = quiet


class WtsHandler(BaseHTTPRequestHandler):
    server: WtsServer
    server_version = "WtS/" + __version__
    protocol_version = "HTTP/1.1"

    # ---------- служебное ----------

    def log_message(self, format, *args):  # noqa: A002 - подпись из stdlib
        if not getattr(self.server, "quiet", False):
            super().log_message(format, *args)

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(HTTPStatus.NO_CONTENT)
        self._cors()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        self._dispatch("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._dispatch("POST")

    def do_DELETE(self) -> None:  # noqa: N802
        self._dispatch("DELETE")

    def _dispatch(self, method: str) -> None:
        parsed = urllib.parse.urlsplit(self.path)
        path = urllib.parse.unquote(parsed.path)
        query = urllib.parse.parse_qs(parsed.query)
        try:
            if path.startswith("/api/wts"):
                self._api(method, path, query)
            elif method == "GET":
                self._static(path)
            else:
                self._json({"error": "метод не поддерживается"}, HTTPStatus.METHOD_NOT_ALLOWED)
        except ValidationPathError as exc:
            self._json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        except planner.ValidationError as exc:
            self._json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        except KeyError:
            self._json({"error": "задача не найдена"}, HTTPStatus.NOT_FOUND)
        except BrokenPipeError:
            pass
        except Exception as exc:  # не отдаём трассировку наружу
            self._json({"error": "внутренняя ошибка сервера: %s" % exc}, HTTPStatus.INTERNAL_SERVER_ERROR)

    # ---------- API ----------

    def _api(self, method: str, path: str, query: dict) -> None:
        manager = self.server.manager

        if path == "/api/wts/health" and method == "GET":
            self._json(
                {
                    "ok": True,
                    "version": __version__,
                    "service": "wts",
                    "stations": len(planner.STATIONS),
                    **manager.stats(),
                }
            )
            return

        if path == "/api/wts/stations" and method == "GET":
            self._json({"stations": planner.station_options(), "hours": list(planner.VALID_HOURS)})
            return

        if path == "/api/wts/jobs" and method == "POST":
            payload = self._read_json()
            job = manager.create_job(payload)
            self._json(job.snapshot(), HTTPStatus.ACCEPTED)
            return

        match = re.match(r"^/api/wts/jobs/([0-9a-f]{32})(/stop|/files|/file|/zip)?$", path)
        if not match:
            self._json({"error": "неизвестный маршрут"}, HTTPStatus.NOT_FOUND)
            return

        job_id, action = match.group(1), match.group(2) or ""

        if not action and method == "GET":
            job = manager.get(job_id)
            since = int(query.get("since", ["0"])[0] or 0)
            self._json(job.snapshot(since=max(0, since)))
            return

        if action == "/stop" and method == "POST":
            self._json(manager.stop(job_id))
            return

        if action == "/files" and method == "GET":
            job = manager.get(job_id)
            files = manager.list_files(job)
            base = "/api/wts/jobs/%s/file?path=" % job.id
            for item in files:
                item["url"] = base + urllib.parse.quote(item["path"])
            self._json(
                {
                    "id": job.id,
                    "files": files,
                    "count": len(files),
                    "zip": "/api/wts/jobs/%s/zip" % job.id if files else "",
                    "counts": job.snapshot()["counts"],
                }
            )
            return

        if action == "/file" and method == "GET":
            job = manager.get(job_id)
            relative = (query.get("path") or [""])[0]
            target = manager.resolve_file(job, relative)
            self._send_file(target, target.name, "application/octet-stream")
            return

        if action == "/zip" and method == "GET":
            job = manager.get(job_id)
            archive = manager.build_zip(job)
            name = "WtS_%s_%s_%s.zip" % (job.station, job.start.isoformat(), job.end.isoformat())
            self._send_file(archive, name, "application/zip")
            return

        if not action and method == "DELETE":
            manager.remove(job_id)
            self._json({"ok": True, "id": job_id})
            return

        self._json({"error": "метод не поддерживается для маршрута"}, HTTPStatus.METHOD_NOT_ALLOWED)

    # ---------- статика сайта ----------

    def _static(self, path: str) -> None:
        if path in STATIC_FILES:
            target = self.server.site_dir / STATIC_FILES[path]
        elif any(path.startswith(prefix) for prefix in STATIC_DIRS):
            relative = path.lstrip("/")
            target = (self.server.site_dir / relative).resolve()
            if self.server.site_dir not in target.parents and target != self.server.site_dir:
                self._json({"error": "файл не найден"}, HTTPStatus.NOT_FOUND)
                return
        else:
            self._not_found()
            return

        if not target.is_file() or target.suffix.lower() not in STATIC_EXT:
            self._not_found()
            return

        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if target.suffix.lower() in (".html", ".css", ".js", ".json", ".txt", ".svg"):
            content_type += "; charset=utf-8"
        data = target.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    # ---------- ответы ----------

    def _read_json(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length", "0") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            return {}
        if length > MAX_BODY:
            raise planner.ValidationError("Слишком большой запрос")
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise planner.ValidationError("Тело запроса не JSON: %s" % exc) from exc
        if not isinstance(payload, dict):
            raise planner.ValidationError("Ожидался JSON-объект")
        return payload

    def _json(self, payload: dict, status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path: Path, download_name: str, content_type: str) -> None:
        try:
            handle = path.open("rb")
        except OSError:
            self._json({"error": "файл не найден"}, HTTPStatus.NOT_FOUND)
            return
        with handle:
            size = os.fstat(handle.fileno()).st_size
            self.send_response(HTTPStatus.OK)
            self._cors()
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(size))
            quoted = urllib.parse.quote(download_name)
            self.send_header(
                "Content-Disposition",
                "attachment; filename=\"%s\"; filename*=UTF-8''%s" % (download_name.encode("ascii", "ignore").decode() or "file", quoted),
            )
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            while True:
                chunk = handle.read(64 * 1024)
                if not chunk:
                    break
                self.wfile.write(chunk)

    def _not_found(self) -> None:
        body = '<?DOCTYPE html><meta charset="utf-8"><title>404</title><p>Страница не найдена. <a href="/">MeteoLab Lite</a>'.encode("utf-8")
        self.send_response(HTTPStatus.NOT_FOUND)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("X-Content-Type-Options", "nosniff")


def default_data_dir() -> Path:
    override = os.environ.get("WTS_DATA_DIR")
    if override:
        return Path(override).expanduser()
    return Path.home() / ".meteolab" / "wts"


def make_server(
    host: str = "127.0.0.1",
    port: int = 8770,
    data_dir: Optional[Path] = None,
    site_dir: Optional[Path] = None,
    quiet: bool = False,
    ttl_hours: Optional[float] = None,
    max_jobs: Optional[int] = None,
) -> WtsServer:
    root = Path(__file__).resolve().parent.parent
    ttl = float(ttl_hours if ttl_hours is not None else os.environ.get("WTS_TTL_HOURS", "24"))
    jobs_limit = int(max_jobs if max_jobs is not None else os.environ.get("WTS_MAX_JOBS", "8"))
    manager = JobManager(Path(data_dir) if data_dir else default_data_dir(), ttl_hours=ttl, max_jobs=jobs_limit)
    return WtsServer((host, port), manager, site_dir or root, quiet=quiet)


def health(host: str = "127.0.0.1", port: int = 8770, timeout: float = 1.5) -> bool:
    """Проверяет, отвечает ли уже запущенный WtS на этом порту."""
    url = "http://%s:%d/api/wts/health" % (host, port)
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return response.status == 200
    except Exception:
        return False


def serve(
    host: str = "127.0.0.1",
    port: int = 8770,
    data_dir: Optional[Path] = None,
    site_dir: Optional[Path] = None,
    ttl_hours: Optional[float] = None,
    max_jobs: Optional[int] = None,
    open_browser: bool = False,
) -> int:
    url = "http://%s:%d/" % (host, port)
    try:
        httpd = make_server(host, port, data_dir, site_dir, ttl_hours=ttl_hours, max_jobs=max_jobs)
    except OSError as exc:
        busy = getattr(exc, "errno", None) in (48, 98, 10048) or getattr(exc, "winerror", None) == 10048
        if busy and health(host, port):
            print("WtS уже запущен: %s" % url)
            if open_browser:
                webbrowser.open(url)
            return 0
        raise

    print("WtS: сайт        %s" % url)
    print("WtS: API         %sapi/wts/health" % url)
    print("WtS: результаты  %s" % httpd.manager.data_dir)
    if open_browser:
        webbrowser.open(url)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nWtS: остановлено")
    finally:
        httpd.server_close()
    return 0
