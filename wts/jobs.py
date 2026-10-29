"""Менеджер фоновых задач массовой загрузки.

Одна задача = один период одной станции. Задачи идут в отдельных потоках, внутри
задачи работает пул из N потоков; HTTP-запрос при этом не блокируется. Все
счётчики и журнал защищены блокировкой, остановка выполняется через событие.
"""

from __future__ import annotations

import os
import re
import shutil
import threading
import time
import uuid
import zipfile
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path
from typing import Callable, Dict, List, Optional, Sequence, Tuple

from . import planner, snd
from .wyoming import FetchOutcome, Sounding, fetch_sounding

Fetcher = Callable[[str, date, str], Tuple[FetchOutcome, Optional[Sounding]]]

STATUS_QUEUED = "queued"
STATUS_RUNNING = "running"
STATUS_STOPPING = "stopping"
STATUS_DONE = "done"
STATUS_STOPPED = "stopped"
STATUS_ERROR = "error"

MAX_LOG_ENTRIES = 20000
JOB_ID_RE = re.compile(r"^[0-9a-f]{32}$")


@dataclass
class LogRecord:
    seq: int
    ts: str
    day: Optional[str]
    hour: str
    status: str
    message: str

    def as_dict(self) -> dict:
        return {
            "seq": self.seq,
            "ts": self.ts,
            "date": self.day or "",
            "hour": self.hour,
            "status": self.status,
            "message": self.message,
        }


@dataclass
class Job:
    id: str
    station: str
    start: date
    end: date
    hours: List[str]
    workers: int
    delay: float
    organize: bool
    root: Path
    status: str = STATUS_QUEUED
    created_at: float = field(default_factory=time.time)
    started_at: Optional[float] = None
    finished_at: Optional[float] = None
    total: int = 0
    completed: int = 0
    ok: int = 0
    failed: int = 0
    skipped: int = 0
    error: str = ""
    log: List[LogRecord] = field(default_factory=list)
    stop_event: threading.Event = field(default_factory=threading.Event)
    lock: threading.Lock = field(default_factory=threading.Lock)
    thread: Optional[threading.Thread] = None
    _seq: int = 0

    def log_line(self, day: Optional[date], hour: str, status: str, message: str) -> None:
        with self.lock:
            self._seq += 1
            self.log.append(
                LogRecord(
                    seq=self._seq,
                    ts=datetime.now().strftime("%H:%M:%S"),
                    day=day.strftime("%d.%m.%Y") if day else None,
                    hour=hour,
                    status=status,
                    message=message,
                )
            )
            if len(self.log) > MAX_LOG_ENTRIES:
                del self.log[: len(self.log) - MAX_LOG_ENTRIES]

    def snapshot(self, since: int = 0, log_limit: int = 400) -> dict:
        with self.lock:
            total = self.total or 0
            percent = round(self.completed / total * 100, 1) if total else 0.0
            entries = [rec.as_dict() for rec in self.log if rec.seq > since][-log_limit:]
            seq = self._seq
            return {
                "id": self.id,
                "status": self.status,
                "station": self.station,
                "start": self.start.isoformat(),
                "end": self.end.isoformat(),
                "hours": list(self.hours),
                "workers": self.workers,
                "delay": self.delay,
                "organize": self.organize,
                "counts": {
                    "total": total,
                    "completed": self.completed,
                    "ok": self.ok,
                    "failed": self.failed,
                    "skipped": self.skipped,
                    "remaining": max(0, total - self.completed),
                },
                "percent": percent,
                "created_at": self.created_at,
                "started_at": self.started_at,
                "finished_at": self.finished_at,
                "elapsed": round((self.finished_at or time.time()) - (self.started_at or self.created_at), 1),
                "error": self.error,
                "log": entries,
                "seq": seq,
            }


class JobManager:
    def __init__(
        self,
        data_dir: Path,
        fetcher: Fetcher = fetch_sounding,
        ttl_hours: float = 24.0,
        max_jobs: int = 8,
    ) -> None:
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.fetcher = fetcher
        self.ttl_hours = ttl_hours
        self.max_jobs = max_jobs
        self.jobs: Dict[str, Job] = {}
        self.lock = threading.Lock()

    # ---------- создание ----------

    def create_job(self, payload: dict) -> Job:
        station = planner.validate_station(payload.get("station"))
        start = planner.parse_date(payload.get("start"), "начальная дата")
        end = planner.parse_date(payload.get("end"), "конечная дата")
        hours = planner.normalize_hours(payload.get("hours"))
        workers = planner.validate_workers(payload.get("workers", 3))
        delay = planner.validate_delay(payload.get("delay", 0.5))
        organize = bool(payload.get("organize", True))
        targets = planner.iter_targets(start, end, hours)

        self.prune_old()
        with self.lock:
            active = [job for job in self.jobs.values() if job.status in (STATUS_QUEUED, STATUS_RUNNING, STATUS_STOPPING)]
            if len(active) >= self.max_jobs:
                raise planner.ValidationError(
                    "Слишком много активных задач (%d). Дождитесь завершения." % len(active)
                )
            job_id = uuid.uuid4().hex
            root = self.data_dir / job_id
            root.mkdir(parents=True, exist_ok=True)
            job = Job(
                id=job_id,
                station=station,
                start=start,
                end=end,
                hours=hours,
                workers=workers,
                delay=delay,
                organize=organize,
                root=root,
                total=len(targets),
            )
            self.jobs[job_id] = job

        job.log_line(None, "", "info", "Задача создана: %d зондов, станция %s" % (len(targets), station))
        thread = threading.Thread(target=self._run, args=(job, targets), name="wts-job-%s" % job_id, daemon=True)
        job.thread = thread
        thread.start()
        return job

    def _run(self, job: Job, targets: Sequence[planner.Target]) -> None:
        with job.lock:
            job.status = STATUS_RUNNING
            job.started_at = time.time()
        job.log_line(
            None,
            "",
            "info",
            "Старт: %s — %s, сроки %s, потоков %d, задержка %.1f с"
            % (job.start.isoformat(), job.end.isoformat(), "/".join(job.hours), job.workers, job.delay),
        )

        try:
            with ThreadPoolExecutor(max_workers=job.workers) as pool:
                futures = [pool.submit(self._worker, job, target) for target in targets]
                for future in futures:
                    if job.stop_event.is_set():
                        break
                    try:
                        future.result()
                    except Exception as exc:  # защита от неожиданных ошибок воркера
                        job.log_line(None, "", "error", "Внутренняя ошибка: %s" % exc)
        except Exception as exc:
            with job.lock:
                job.error = str(exc)
                job.status = STATUS_ERROR
            job.log_line(None, "", "error", "Задача прервана: %s" % exc)
        finally:
            with job.lock:
                job.finished_at = time.time()
                if job.stop_event.is_set():
                    job.status = STATUS_STOPPED
                elif job.status != STATUS_ERROR:
                    job.status = STATUS_DONE
                summary = (job.ok, job.failed, job.skipped, job.total)
            job.log_line(
                None,
                "",
                "header",
                "Итог: успешно %d, ошибок %d, пропущено %d из %d" % summary,
            )

    def _worker(self, job: Job, target: planner.Target) -> None:
        if job.stop_event.is_set():
            return
        if job.delay > 0:
            if job.stop_event.wait(job.delay):
                return

        try:
            outcome, sounding = self.fetcher(job.station, target.day, target.hour)
        except Exception as exc:
            outcome, sounding = FetchOutcome("error", error=str(exc)), None

        if outcome.status == "ok" and sounding is not None:
            try:
                self._save(job, target, sounding)
            except OSError as exc:
                self._count(job, target, "error", "не удалось записать файл: %s" % exc)
                return
            self._count(job, target, "ok", "сохранён %s" % snd.filename(job.station, target.day, target.hour))
            return

        if outcome.status == "no_data":
            self._count(job, target, "skip", outcome.error or "Нет данных")
            return
        self._count(job, target, "error", outcome.error or "Неизвестная ошибка")

    def _save(self, job: Job, target: planner.Target, sounding: Sounding) -> None:
        parts = planner.organize_parts(target, job.organize)
        folder = job.root.joinpath(*parts) if parts else job.root
        path = folder / snd.filename(job.station, target.day, target.hour)
        snd.write_snd(path, sounding)

    def _count(self, job: Job, target: planner.Target, kind: str, message: str) -> None:
        with job.lock:
            job.completed += 1
            if kind == "ok":
                job.ok += 1
            elif kind == "skip":
                job.skipped += 1
            else:
                job.failed += 1
        job.log_line(target.day, target.hour, kind, message)

    # ---------- управление ----------

    def get(self, job_id: str) -> Job:
        if not JOB_ID_RE.match(str(job_id or "")):
            raise KeyError(job_id)
        with self.lock:
            job = self.jobs.get(job_id)
        if job is None:
            raise KeyError(job_id)
        return job

    def stop(self, job_id: str) -> dict:
        job = self.get(job_id)
        if job.status in (STATUS_QUEUED, STATUS_RUNNING):
            with job.lock:
                job.status = STATUS_STOPPING
            job.stop_event.set()
            job.log_line(None, "", "skipped", "Остановка по запросу пользователя")
        return job.snapshot()

    def remove(self, job_id: str) -> None:
        job = self.get(job_id)
        job.stop_event.set()
        with self.lock:
            self.jobs.pop(job_id, None)
        shutil.rmtree(job.root, ignore_errors=True)

    def prune_old(self) -> int:
        """Удаляет каталоги задач старше TTL, чтобы не копить файлы."""
        if self.ttl_hours <= 0:
            return 0
        limit = time.time() - self.ttl_hours * 3600
        removed = 0
        with self.lock:
            alive = {job.id for job in self.jobs.values() if job.status in (STATUS_QUEUED, STATUS_RUNNING, STATUS_STOPPING)}
        for entry in self.data_dir.iterdir():
            if not entry.is_dir() or entry.name in alive:
                continue
            try:
                if entry.stat().st_mtime >= limit:
                    continue
            except OSError:
                continue
            shutil.rmtree(entry, ignore_errors=True)
            removed += 1
            with self.lock:
                self.jobs.pop(entry.name, None)
        return removed

    # ---------- результаты ----------

    def list_files(self, job: Job) -> List[dict]:
        files: List[dict] = []
        if not job.root.exists():
            return files
        for path in sorted(job.root.rglob("*.snd")):
            if not path.is_file():
                continue
            relative = path.relative_to(job.root)
            files.append(
                {
                    "path": relative.as_posix(),
                    "name": path.name,
                    "size": path.stat().st_size,
                    "folder": relative.parent.as_posix() if relative.parent.parts else "",
                }
            )
        return files

    def resolve_file(self, job: Job, relative: str) -> Path:
        """Путь внутри каталога задачи или отказ — защита от обхода каталогов."""
        if not relative:
            raise ValidationPathError("Не указан файл")
        raw = str(relative).replace("\\", "/")
        if raw.startswith("/") or re.match(r"^[A-Za-z]:", raw):
            raise ValidationPathError("Абсолютные пути запрещены")
        if ".." in raw.split("/"):
            raise ValidationPathError("Переход вверх по каталогу запрещён")
        candidate = (job.root / raw).resolve()
        root = job.root.resolve()
        if candidate != root and root not in candidate.parents:
            raise ValidationPathError("Файл вне каталога задачи")
        if candidate.suffix.lower() != ".snd" or not candidate.is_file():
            raise ValidationPathError("Файл не найден")
        return candidate

    def build_zip(self, job: Job) -> Path:
        archive = job.root / "wts-sharpy.zip"
        if archive.exists() and archive.stat().st_mtime >= self._newest_snd(job, archive):
            return archive
        tmp = archive.with_suffix(".tmp")
        with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
            files = self.list_files(job)
            for info in files:
                source = job.root / info["path"]
                bundle.write(source, arcname=info["path"])
            readme = (
                "WtS — массовая загрузка зондов Wyoming\n"
                "Станция %s, период %s — %s, сроки %s\n"
                "Файлы .snd разложены по годам/месяцам/срокам и открываются в SHARPpy.\n"
            ) % (job.station, job.start.isoformat(), job.end.isoformat(), "/".join(job.hours))
            bundle.writestr("README.txt", readme)
        os.replace(tmp, archive)
        return archive

    @staticmethod
    def _newest_snd(job: Job, archive: Path) -> float:
        newest = 0.0
        for path in job.root.rglob("*.snd"):
            try:
                newest = max(newest, path.stat().st_mtime)
            except OSError:
                continue
        return newest

    def stats(self) -> dict:
        with self.lock:
            jobs = list(self.jobs.values())
        return {
            "jobs": len(jobs),
            "active": sum(1 for job in jobs if job.status in (STATUS_QUEUED, STATUS_RUNNING, STATUS_STOPPING)),
        }


class ValidationPathError(ValueError):
    """Запрошенный путь недопустим."""
