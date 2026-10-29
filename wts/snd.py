"""Формирование файлов .snd, совместимых с SHARPpy.

Структура повторяет ту, что писала исходная WtS_mass.py:

    %TITLE%
     24959   240601/1200
       LEVEL      HGHT       TEMP       DWPT       WDIR       WSPD
    ------------------------------------------------------------------
    %RAW%
     1000.0,     101.0,      20.2,      15.2,       0.0,       0.0
    %END%

Порядок колонок — давление (гПа), высота (м), температура (°C), точка росы (°C),
направление ветра (град) и скорость ветра (kt). Скорость приводится к узлам
до записи, потому что именно узлы ожидает SHARPpy.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path
from typing import Iterable

from .wyoming import Level, Sounding

COLUMN_HEADER = "   LEVEL      HGHT       TEMP       DWPT       WDIR       WSPD"
SEPARATOR = "-" * 66


def filename(station: str, day: date, hour: str) -> str:
    return "%s_%04d%02d%02d_%sZ.snd" % (station, day.year, day.month, day.day, hour)


def title_line(station: str, day: date, hour: str) -> str:
    return " %s   %02d%02d%02d/%s00" % (
        station,
        day.year % 100,
        day.month,
        day.day,
        hour,
    )


def format_level(level: Level) -> str:
    depth = level.dwpt if level.dwpt is not None else 0.0
    return "%7.1f,%10.1f,%10.1f,%10.1f,%10.1f,%10.1f" % (
        level.pres,
        level.hght,
        level.temp,
        depth,
        level.wdir,
        level.wspd,
    )


def render_snd(sounding: Sounding) -> str:
    levels = sounding.to_knots()
    lines = [
        "%TITLE%",
        title_line(sounding.station, sounding.day, sounding.hour),
        COLUMN_HEADER,
        SEPARATOR,
        "%RAW%",
    ]
    lines.extend(format_level(level) for level in levels)
    lines.append("%END%")
    return "\n".join(lines) + "\n"


def write_snd(path: Path, sounding: Sounding) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = render_snd(sounding)
    path.write_text(payload, encoding="utf-8", newline="\n")
    return len(payload)


def parse_snd(text: str) -> list:
    """Минимальный независимый разбор .snd — для самопроверки результата."""
    rows = []
    inside = "%RAW%" in text
    for line in text.splitlines():
        stripped = line.strip()
        if not inside:
            if stripped == "%RAW%":
                inside = True
            continue
        if stripped.startswith("%END%"):
            break
        if not stripped or "," not in stripped:
            continue
        parts = [part.strip() for part in stripped.split(",")]
        if len(parts) < 6:
            continue
        rows.append(tuple(float(value) for value in parts[:6]))
    return rows


def month_folder_name(month: int, months_ru: Iterable[str] = ()) -> str:
    names = list(months_ru)
    if len(names) >= 12:
        return "%02d - %s" % (month, names[month - 1])
    return "%02d" % month
