"""Тесты WtS: разбор Wyoming, .snd, планирование, задачи и HTTP API.

Сеть не используется: HTTP-клиент подменяется функцией-фикстурой, реальный
ответ Wyoming лежит в tests/fixtures и разбирается как обычный текст.
Запуск: python -m unittest discover -s tests -v
"""

from __future__ import annotations

import io
import json
import threading
import time
import unittest
import urllib.error
import urllib.request
import zipfile
from datetime import date
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from wts import planner, snd as snd_mod, wyoming
from wts.jobs import JobManager, ValidationPathError
from wts.server import WtsServer
from wts.wyoming import FetchOutcome, Sounding

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "tests" / "fixtures" / "wyoming_24959_20240601_12.html"


def load_sounding() -> Sounding:
    text = FIXTURE.read_text(encoding="utf-8")
    return wyoming.parse_wyoming_text(text, station="24959", day=date(2024, 6, 1), hour="12")


def fake_fetcher(station: str, day: date, hour: str):
    if day.day == 3:
        return FetchOutcome("no_data", error="Нет данных"), None
    if day.day == 4:
        return FetchOutcome("error", error="HTTP 500"), None
    sounding = load_sounding()
    sounding.station = station
    sounding.day = day
    sounding.hour = hour
    return FetchOutcome("ok", text="fixture"), sounding


class WyomingParserTests(unittest.TestCase):
    def test_real_response_parsed(self):
        sounding = load_sounding()
        self.assertEqual(len(sounding.levels), 58)
        self.assertEqual(sounding.columns[:8], ["PRES", "HGHT", "TEMP", "DWPT", "RELH", "MIXR", "DRCT", "SPED"])

    def test_units_detected_from_units_row(self):
        sounding = load_sounding()
        self.assertEqual(sounding.wind_unit, "m/s")
        self.assertEqual(sounding.wind_unit_source, "units-row")

    def test_values_and_order(self):
        sounding = load_sounding()
        first = sounding.levels[0]
        self.assertAlmostEqual(first.pres, 1000.0)
        self.assertAlmostEqual(first.hght, 101.0)
        self.assertAlmostEqual(first.temp, 20.2)
        self.assertAlmostEqual(first.dwpt, 15.2)
        levels = sounding.levels
        self.assertTrue(all(levels[i].pres >= levels[i + 1].pres for i in range(len(levels) - 1)))

    def test_mps_to_knots(self):
        sounding = load_sounding()
        knots = {round(lv.pres, 1): lv.wspd for lv in sounding.to_knots()}
        self.assertAlmostEqual(knots[850.0], 7.0 * 1.943844, places=3)
        self.assertAlmostEqual(knots[500.0], 15.0 * 1.943844, places=3)

    def test_incomplete_line_keeps_previous_wind(self):
        sounding = load_sounding()
        last = sounding.levels[-1]
        self.assertAlmostEqual(last.pres, 13.8)
        self.assertTrue(last.wind_missing)
        self.assertAlmostEqual(last.wind_dir) if False else None
        previous = sounding.levels[-2]
        self.assertAlmostEqual(last.wdir, previous.wdir)
        self.assertAlmostEqual(last.wspd, previous.wspd)

    def test_kt_column_has_no_conversion(self):
        text = (
            "<PRE>\n"
            "   PRES   HGHT   TEMP   DWPT   DRCT   SKNT\n"
            "    hPa      m      C      C    deg     kt\n"
            " 1000.0    100   20.0   15.0    180     10\n"
            "  925.0    800   18.0   12.0    190     12\n"
            "  850.0   1500   15.0    9.0    200     14\n"
            "  700.0   3000    5.0   -1.0    210     20\n"
            "  500.0   5600  -10.0  -18.0    220     30\n"
            "</PRE>\n"
        )
        sounding = wyoming.parse_wyoming_text(text, station="00000", day=date(2024, 1, 1), hour="00")
        self.assertEqual(sounding.wind_unit, "kt")
        self.assertEqual(len(sounding.levels), 5)
        self.assertAlmostEqual(sounding.to_knots()[0].wspd, 10.0)

    def test_no_data_markers(self):
        with self.assertRaises(wyoming.NoDataError):
            wyoming.parse_wyoming_text("<html>Can't get sounding</html>")
        with self.assertRaises(wyoming.NoDataError):
            wyoming.parse_wyoming_text("No data for this time")

    def test_empty_and_short_answers(self):
        with self.assertRaises(wyoming.ParseError):
            wyoming.parse_wyoming_text("")
        short = (
            "<PRE>\n   PRES   HGHT   TEMP   DWPT   DRCT   SPED\n"
            "    hPa      m      C      C    deg    m/s\n"
            " 1000.0    100   20.0   15.0    180      1\n"
            "  900.0    900   10.0    5.0    190      2\n"
            "</PRE>\n"
        )
        with self.assertRaises(wyoming.ParseError):
            wyoming.parse_wyoming_text(short)

    def test_url_uses_wyoming_endpoint(self):
        url = wyoming.build_url("24959", date(2024, 6, 1), "12")
        self.assertIn("weather.arcc.uwyo.edu/wsgi/sounding", url)
        self.assertIn("id=24959", url)
        self.assertIn("TEXT", url)
        self.assertIn("12%3A00%3A00", url.replace("%20", " "))


class SndFormatTests(unittest.TestCase):
    def test_structure(self):
        text = snd_mod.render_snd(load_sounding())
        lines = text.splitlines()
        self.assertEqual(lines[0], "%TITLE%")
        self.assertEqual(lines[1], " 24959   240601/1200")
        self.assertIn("LEVEL", lines[2])
        self.assertEqual(lines[4], "%RAW%")
        self.assertEqual(lines[-1], "%END%")
        self.assertEqual(len(snd_mod.parse_snd(text)), 58)

    def test_wind_speed_written_in_knots(self):
        rows = snd_mod.parse_snd(snd_mod.render_snd(load_sounding()))
        row_850 = [row for row in rows if abs(row[0] - 850.0) < 0.01][0]
        self.assertAlmostEqual(row_850[5], 7.0 * 1.943844, places=1)

    def test_columns_are_pressure_height_temp_dewpoint_dir_speed(self):
        rows = snd_mod.parse_snd(snd_mod.render_snd(load_sounding()))
        first = rows[0]
        self.assertAlmostEqual(first[0], 1000.0)
        self.assertAlmostEqual(first[1], 101.0)
        self.assertAlmostEqual(first[2], 20.2)
        self.assertAlmostEqual(first[3], 15.2)
        self.assertAlmostEqual(first[4], 0.0)

    def test_filename(self):
        self.assertEqual(snd_mod.filename("24959", date(2024, 6, 1), "12"), "24959_20240601_12Z.snd")


class PlannerTests(unittest.TestCase):
    def test_hours(self):
        self.assertEqual(planner.normalize_hours(["00", "12"]), ["00", "12"])
        self.assertEqual(planner.normalize_hours(["12"]), ["12"])
        with self.assertRaises(planner.ValidationError):
            planner.normalize_hours([])
        with self.assertRaises(planner.ValidationError):
            planner.normalize_hours(["06"])

    def test_targets_count(self):
        targets = planner.iter_targets(date(2024, 1, 1), date(2024, 1, 3), ["00", "12"])
        self.assertEqual(len(targets), 6)
        self.assertEqual(targets[0].hour, "00")
        self.assertEqual(targets[-1].hour, "12")

    def test_invalid_range(self):
        with self.assertRaises(planner.ValidationError):
            planner.iter_targets(date(2024, 2, 2), date(2024, 1, 1), ["00"])

    def test_too_many_targets(self):
        with self.assertRaises(planner.ValidationError):
            planner.iter_targets(date(2000, 1, 1), date(2024, 1, 1), ["00", "12"])

    def test_quick_ranges(self):
        start, end = planner.last_month(date(2024, 1, 15))
        self.assertEqual(start, date(2023, 12, 1))
        self.assertEqual(end, date(2024, 1, 15))
        start, end = planner.last_year(date(2024, 6, 10))
        self.assertEqual((start, end), (date(2023, 6, 10), date(2024, 6, 10)))

    def test_parameters(self):
        with self.assertRaises(planner.ValidationError):
            planner.validate_station("abc")
        with self.assertRaises(planner.ValidationError):
            planner.validate_workers(0)
        with self.assertRaises(planner.ValidationError):
            planner.validate_delay(-1)
        self.assertEqual(planner.validate_station("24959"), "24959")

    def test_organize_parts(self):
        target = planner.Target(date(2024, 6, 1), "12")
        self.assertEqual(planner.organize_parts(target, True), ["2024", "06 - Июнь", "12 UTC"])
        self.assertEqual(planner.organize_parts(target, False), [])


class JobTests(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.manager = JobManager(Path(self.tmp.name), fetcher=fake_fetcher)

    def tearDown(self):
        self.manager.prune_old()
        self.tmp.cleanup()

    def _wait(self, job, timeout=10.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if job.status in ("done", "stopped", "error"):
                return job
            time.sleep(0.02)
        raise AssertionError("задача не завершилась: %s" % job.status)

    def test_success_no_data_and_error(self):
        job = self.manager.create_job(
            {
                "station": "24959",
                "start": "2024-06-01",
                "end": "2024-06-04",
                "hours": ["00", "12"],
                "workers": 2,
                "delay": 0,
            }
        )
        self._wait(job)
        snap = job.snapshot()
        self.assertEqual(snap["status"], "done")
        self.assertEqual(snap["counts"]["total"], 8)
        self.assertEqual(snap["counts"]["ok"], 4)
        self.assertEqual(snap["counts"]["skipped"], 2)
        self.assertEqual(snap["counts"]["failed"], 2)
        self.assertEqual(snap["percent"], 100.0)

    def test_files_layout_and_zip(self):
        job = self.manager.create_job(
            {
                "station": "24959",
                "start": "2024-06-01",
                "end": "2024-06-01",
                "hours": ["12"],
                "workers": 1,
                "delay": 0,
            }
        )
        self._wait(job)
        files = self.manager.list_files(job)
        self.assertEqual(len(files), 1)
        self.assertEqual(files[0]["path"], "2024/06 - Июнь/12 UTC/24959_20240601_12Z.snd")

        archive = self.manager.build_zip(job)
        with zipfile.ZipFile(archive) as bundle:
            names = bundle.namelist()
        self.assertIn("2024/06 - Июнь/12 UTC/24959_20240601_12Z.snd", names)
        self.assertIn("README.txt", names)

    def test_flat_layout(self):
        job = self.manager.create_job(
            {
                "station": "24959",
                "start": "2024-06-01",
                "end": "2024-06-01",
                "hours": ["00"],
                "organize": False,
                "delay": 0,
            }
        )
        self._wait(job)
        self.assertEqual(self.manager.list_files(job)[0]["path"], "24959_20240601_00Z.snd")

    def test_stop(self):
        slow_manager = JobManager(Path(self.tmp.name), fetcher=fake_fetcher)
        slow_manager.fetcher = lambda station, day, hour: (time.sleep(0.05), fake_fetcher(station, day, hour))[1]
        job = slow_manager.create_job(
            {
                "station": "24959",
                "start": "2024-06-01",
                "end": "2024-06-20",
                "hours": ["00", "12"],
                "workers": 1,
                "delay": 0,
            }
        )
        time.sleep(0.15)
        slow_manager.stop(job.id)
        self._wait(job)
        self.assertIn(job.status, ("stopped", "done"))
        self.assertLess(job.completed, job.total)

    def test_path_traversal_rejected(self):
        job = self.manager.create_job(
            {"station": "24959", "start": "2024-06-01", "end": "2024-06-01", "hours": ["00"], "delay": 0}
        )
        self._wait(job)
        for bad in ("../secret.snd", "/etc/passwd", "C:/windows/x.snd", "..\\x.snd"):
            with self.assertRaises(ValidationPathError):
                self.manager.resolve_file(job, bad)
        with self.assertRaises(ValidationPathError):
            self.manager.resolve_file(job, "2024/нет-такого.snd")

    def test_validation_errors(self):
        with self.assertRaises(planner.ValidationError):
            self.manager.create_job({"station": "24959", "start": "2024-06-05", "end": "2024-06-01", "hours": ["00"]})
        with self.assertRaises(planner.ValidationError):
            self.manager.create_job({"station": "", "start": "2024-06-01", "end": "2024-06-01", "hours": ["00"]})


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = TemporaryDirectory()
        manager = JobManager(Path(cls.tmp.name), fetcher=fake_fetcher)
        cls.server = WtsServer(("127.0.0.1", 0), manager, ROOT, quiet=True)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.tmp.cleanup()

    def url(self, path):
        return "http://127.0.0.1:%d%s" % (self.port, path)

    def request(self, path, method="GET", payload=None):
        data = None
        headers = {}
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self.url(path), data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=10) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read()

    def test_health(self):
        status, body = self.request("/api/wts/health")
        self.assertEqual(status, 200)
        payload = json.loads(body)
        self.assertTrue(payload["ok"])
        self.assertGreaterEqual(payload["stations"], 19)

    def test_stations(self):
        status, body = self.request("/api/wts/stations")
        self.assertEqual(status, 200)
        stations = json.loads(body)["stations"]
        self.assertTrue(any(item["wmo"] == "24959" for item in stations))

    def test_site_served(self):
        status, body = self.request("/")
        self.assertEqual(status, 200)
        self.assertIn(b"MeteoLab", body)

    def test_full_flow(self):
        status, body = self.request(
            "/api/wts/jobs",
            "POST",
            {
                "station": "24959",
                "start": {"y": 2024, "m": 6, "d": 1},
                "end": {"y": 2024, "m": 6, "d": 2},
                "hours": ["00", "12"],
                "workers": 2,
                "delay": 0,
            },
        )
        self.assertEqual(status, 202)
        job_id = json.loads(body)["id"]

        snapshot = {}
        deadline = time.time() + 10
        while time.time() < deadline:
            _, body = self.request("/api/wts/jobs/%s?since=0" % job_id)
            snapshot = json.loads(body)
            if snapshot["status"] in ("done", "stopped", "error"):
                break
            time.sleep(0.05)
        self.assertEqual(snapshot["status"], "done")
        self.assertEqual(snapshot["counts"]["total"], 4)
        self.assertTrue(any(entry["status"] == "ok" for entry in snapshot["log"]))

        status, body = self.request("/api/wts/jobs/%s/files" % job_id)
        self.assertEqual(status, 200)
        files = json.loads(body)["files"]
        self.assertEqual(len(files), 4)

        status, body = self.request(files[0]["url"])
        self.assertEqual(status, 200)
        self.assertIn(b"%TITLE%", body)
        self.assertIn(b"%END%", body)

        status, body = self.request("/api/wts/jobs/%s/zip" % job_id)
        self.assertEqual(status, 200)
        with zipfile.ZipFile(io.BytesIO(body)) as bundle:
            self.assertEqual(len([n for n in bundle.namelist() if n.endswith(".snd")]), 4)

    def test_bad_requests(self):
        status, _ = self.request(
            "/api/wts/jobs", "POST", {"station": "24959", "start": "2024-06-05", "end": "2024-06-01", "hours": ["00"]}
        )
        self.assertEqual(status, 400)
        status, _ = self.request("/api/wts/jobs/%s" % ("0" * 32))
        self.assertEqual(status, 404)
        status, _ = self.request("/api/wts/jobs")
        self.assertEqual(status, 404)

    def test_traversal_over_api(self):
        _, body = self.request(
            "/api/wts/jobs",
            "POST",
            {"station": "24959", "start": "2024-06-01", "end": "2024-06-01", "hours": ["00"], "delay": 0},
        )
        job_id = json.loads(body)["id"]
        time.sleep(0.2)
        status, _ = self.request("/api/wts/jobs/%s/file?path=../../../windows/win.ini" % job_id)
        self.assertIn(status, (400, 404))

    def test_stop_endpoint(self):
        _, body = self.request(
            "/api/wts/jobs",
            "POST",
            {"station": "24959", "start": "2024-06-01", "end": "2024-06-30", "hours": ["00", "12"], "workers": 1, "delay": 0},
        )
        job_id = json.loads(body)["id"]
        status, body = self.request("/api/wts/jobs/%s/stop" % job_id, "POST", {})
        self.assertEqual(status, 200)
        self.assertIn(json.loads(body)["status"], ("stopping", "stopped", "done"))


class FetchTests(unittest.TestCase):
    """HTTP-слой проверяется подменой urlopen: в тестах нет сети."""

    class Response:
        def __init__(self, body: bytes, charset: str = "utf-8", status: int = 200):
            self._body = body
            self.status = status
            self.headers = mock.Mock()
            self.headers.get_content_charset.return_value = charset

        def read(self):
            return self._body

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    def test_ok(self):
        body = FIXTURE.read_bytes()
        with mock.patch("wts.wyoming.urllib.request.urlopen", return_value=self.Response(body)):
            outcome = wyoming.fetch_raw("http://example.invalid")
        self.assertEqual(outcome.status, "ok")
        self.assertIn("PRES", outcome.text)

    def test_404_is_no_data(self):
        error = urllib.error.HTTPError("http://example.invalid", 404, "Not Found", {}, None)
        with mock.patch("wts.wyoming.urllib.request.urlopen", side_effect=error):
            outcome = wyoming.fetch_raw("http://example.invalid")
        self.assertEqual(outcome.status, "no_data")
        self.assertEqual(outcome.http_status, 404)

    def test_network_error(self):
        error = urllib.error.URLError("нет соединения")
        with mock.patch("wts.wyoming.urllib.request.urlopen", side_effect=error):
            outcome = wyoming.fetch_raw("http://example.invalid")
        self.assertEqual(outcome.status, "error")
        self.assertIn("нет соединения", outcome.error)

    def test_marker_in_body(self):
        body = b"<html><PRE>Can't get data for this time</PRE></html>"
        with mock.patch("wts.wyoming.urllib.request.urlopen", return_value=self.Response(body)):
            outcome = wyoming.fetch_raw("http://example.invalid")
        self.assertEqual(outcome.status, "no_data")

    def test_fetch_sounding_parses(self):
        body = FIXTURE.read_bytes()
        with mock.patch("wts.wyoming.urllib.request.urlopen", return_value=self.Response(body)):
            outcome, sounding = wyoming.fetch_sounding("24959", date(2024, 6, 1), "12")
        self.assertTrue(outcome.ok)
        self.assertIsNotNone(sounding)
        self.assertEqual(len(sounding.levels), 58)


class StaticTests(unittest.TestCase):
    def test_unknown_path_404(self):
        with TemporaryDirectory() as tmp:
            manager = JobManager(Path(tmp), fetcher=fake_fetcher)
            server = WtsServer(("127.0.0.1", 0), manager, ROOT, quiet=True)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                url = "http://127.0.0.1:%d/%s" % (server.server_address[1], "missing-page.html")
                with self.assertRaises(urllib.error.HTTPError) as ctx:
                    urllib.request.urlopen(url, timeout=5)
                self.assertEqual(ctx.exception.code, 404)
            finally:
                server.shutdown()
                server.server_close()

    def test_src_styles_served(self):
        with TemporaryDirectory() as tmp:
            manager = JobManager(Path(tmp), fetcher=fake_fetcher)
            server = WtsServer(("127.0.0.1", 0), manager, ROOT, quiet=True)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                url = "http://127.0.0.1:%d/src/styles.css" % server.server_address[1]
                with urllib.request.urlopen(url, timeout=5) as response:
                    self.assertEqual(response.status, 200)
                    self.assertIn(b"--accent", response.read())
            finally:
                server.shutdown()
                server.server_close()


if __name__ == "__main__":
    unittest.main()

