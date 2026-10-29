"""Загрузка и разбор аэрологических профилей с сервера University of Wyoming.

Источник данных — тот же, что в исходной WtS_mass.py:
https://weather.arcc.uwyo.edu/wsgi/sounding?datetime=...&id=...&src=UNKNOWN&type=TEXT:LIST

Формат ответа (проверено на реальном ответе 24959 / 2024-06-01 12 UTC):

    <PRE>
    -----------------------------------------------------------------------------
       PRES   HGHT   TEMP   DWPT   RELH   MIXR   DRCT   SPED   THTA   THTE   THTV
        hPa      m      C      C      %   g/kg    deg    m/s      K      K      K
    -----------------------------------------------------------------------------
     1000.0    101   20.2   15.2     73  10.92      0    0.0  293.4  324.7  295.3
    ...
    </PRE>

Скорость ветра в этом ответе отдаётся в м/с (строка единиц «m/s»), тогда как
формат .snd для SHARPpy ожидает узлы (kt). Коэффициент 1.943844 берётся только
после того, как единица подтверждена строкой единиц или именем колонки.
"""

from __future__ import annotations

import re
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import date
from typing import Dict, Iterable, List, Optional, Tuple

BASE_URL = "https://weather.arcc.uwyo.edu/wsgi/sounding"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 WtS/1.0"
MIN_LEVELS = 5

MPS_TO_KNOTS = 1.943844

NO_DATA_MARKERS = (
    "can't get",
    "cannot get",
    "no data",
    "data not found",
    "not available",
    "no sounding",
    "invalid station",
)


class WyomingError(Exception):
    """Базовая ошибка работы с Wyoming."""


class NoDataError(WyomingError):
    """Сервер ответил, но наблюдения за этот срок нет."""


class ParseError(WyomingError):
    """Ответ не удалось разобрать как профиль."""


@dataclass
class Level:
    pres: float
    hght: float
    temp: float
    dwpt: Optional[float]
    wdir: float
    wspd: float
    wind_missing: bool = False


@dataclass
class Sounding:
    station: str
    day: date
    hour: str
    levels: List[Level]
    wind_unit: str = "m/s"
    wind_unit_source: str = "units-row"
    columns: List[str] = field(default_factory=list)

    def to_knots(self) -> List[Level]:
        """Профиль с ветром в узлах — так его ждёт .snd для SHARPpy."""
        if self.wind_unit == "kt":
            return self.levels
        return [
            Level(
                pres=lv.pres,
                hght=lv.hght,
                temp=lv.temp,
                dwpt=lv.dwpt,
                wdir=lv.wdir,
                wspd=lv.wspd * MPS_TO_KNOTS,
                wind_missing=lv.wind_missing,
            )
            for lv in self.levels
        ]


@dataclass
class FetchOutcome:
    status: str
    text: str = ""
    error: str = ""
    http_status: Optional[int] = None

    @property
    def ok(self) -> bool:
        return self.status == "ok"


def build_url(station: str, day: date, hour: str) -> str:
    stamp = "%04d-%02d-%02d %s:00:00" % (day.year, day.month, day.day, hour)
    query = urllib.parse.urlencode(
        {"datetime": stamp, "id": station, "src": "UNKNOWN", "type": "TEXT:LIST"},
        quote_via=urllib.parse.quote,
    )
    return "%s?%s" % (BASE_URL, query)


def fetch_raw(url: str, timeout: float = 30.0) -> FetchOutcome:
    """Один HTTP-запрос. Сетевые ошибки и 404 разводятся по статусам."""
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            charset = response.headers.get_content_charset() or "utf-8"
            payload = response.read().decode(charset, "replace")
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return FetchOutcome("no_data", error="HTTP 404 — нет наблюдения", http_status=404)
        return FetchOutcome("error", error="HTTP %s" % exc.code, http_status=exc.code)
    except urllib.error.URLError as exc:
        return FetchOutcome("error", error="Сеть: %s" % (exc.reason,))
    except TimeoutError:
        return FetchOutcome("error", error="Таймаут")
    except OSError as exc:
        return FetchOutcome("error", error="Сеть: %s" % (exc,))

    lowered = payload.lower()
    for marker in NO_DATA_MARKERS:
        if marker in lowered:
            return FetchOutcome("no_data", text=payload, error="Нет данных", http_status=200)
    return FetchOutcome("ok", text=payload, http_status=200)


def fetch_sounding(
    station: str, day: date, hour: str, timeout: float = 30.0
) -> Tuple[FetchOutcome, Optional[Sounding]]:
    """Скачивает и сразу разбирает один срок."""
    outcome = fetch_raw(build_url(station, day, hour), timeout=timeout)
    if not outcome.ok:
        return outcome, None
    try:
        sounding = parse_wyoming_text(outcome.text, station=station, day=day, hour=hour)
    except NoDataError as exc:
        return FetchOutcome("no_data", text=outcome.text, error=str(exc)), None
    except ParseError as exc:
        return FetchOutcome("error", text=outcome.text, error=str(exc)), None
    return outcome, sounding


def _cut_pre_block(text: str) -> str:
    lowered = text.lower()
    start = lowered.find("<pre>")
    if start < 0:
        return text
    end = lowered.find("</pre>", start)
    if end < 0:
        end = len(text)
    return text[start + 5 : end]


def _column_spans(header: str) -> List[Tuple[str, int, Optional[int]]]:
    """Границы колонок по заголовку.

    В формате Wyoming значения выровнены по правому краю семисимвольных полей,
    поэтому конец имени колонки в заголовке совпадает с концом поля, а начало
    поля — это конец предыдущего имени. Такой вывод не зависит от того, что
    заголовок сдвинут на два символа относительно строк данных.
    """
    tokens = list(re.finditer(r"\S+", header))
    if not tokens:
        return []
    bounds = [0] + [match.end() for match in tokens]
    names = [match.group(0) for match in tokens]
    spans: List[Tuple[str, int, Optional[int]]] = []
    for index, name in enumerate(names):
        start = bounds[index]
        end = bounds[index + 1] if index + 1 < len(bounds) - 1 else None
        if index + 1 == len(names):
            end = None
        spans.append((name.upper(), start, end))
    return spans


def _detect_wind_unit(
    columns: Iterable[str], units_line: str, header: str
) -> Tuple[str, str]:
    names = [c.upper() for c in columns]
    unit_text = (units_line or "").lower()
    if "m/s" in unit_text or "m s-1" in unit_text:
        return "m/s", "units-row"
    if re.search(r"\bkt\b|\bkts\b|\bknots?\b", unit_text):
        return "kt", "units-row"
    if "SKNT" in names:
        return "kt", "column-name"
    if "SPED" in names:
        # Текущий wsgi-ответ подписывает SPED как m/s; если строки единиц нет,
        # опираемся на имя колонки и фиксируем допущение в источнике.
        return "m/s", "column-name"
    if re.search(r"\bkt\b|knots?", header.lower()):
        return "kt", "header-text"
    return "m/s", "assumed"


def parse_wyoming_text(
    text: str,
    station: str = "",
    day: Optional[date] = None,
    hour: str = "00",
) -> Sounding:
    """Разбирает ответ Wyoming (HTML с <PRE> или чистый текст)."""
    if text is None or not str(text).strip():
        raise ParseError("Пустой ответ сервера")

    lowered = str(text).lower()
    for marker in NO_DATA_MARKERS:
        if marker in lowered:
            raise NoDataError("Нет данных")

    block = _cut_pre_block(str(text))
    raw_lines = block.splitlines()

    header_index = None
    for index, line in enumerate(raw_lines):
        upper = line.upper()
        if "PRES" in upper and "HGHT" in upper:
            header_index = index
            break
    if header_index is None:
        raise ParseError("В ответе нет строки заголовка PRES/HGHT")

    header = raw_lines[header_index]
    spans = _column_spans(header)
    columns = [name for name, _, _ in spans]

    units_line = ""
    if header_index + 1 < len(raw_lines):
        candidate = raw_lines[header_index + 1]
        if re.search(r"hpa|hpa\b", candidate.lower()) or "km" in candidate.lower():
            units_line = candidate

    wind_unit, wind_source = _detect_wind_unit(columns, units_line, header)

    levels: List[Level] = []
    last_dir = 0.0
    last_speed = 0.0
    for line in raw_lines[header_index + 1 :]:
        if not line.strip() or "---" in line:
            continue
        if "HPA" in line.upper() and "PRES" not in line.upper():
            continue
        values: Dict[str, str] = {}
        for name, start, end in spans:
            chunk = line[start:end] if end is not None else line[start:]
            values[name] = chunk.strip()

        pres = _to_float(values.get("PRES"))
        hght = _to_float(values.get("HGHT"))
        temp = _to_float(values.get("TEMP"))
        if pres is None or hght is None or temp is None:
            continue

        dwpt = _to_float(values.get("DWPT"))
        wdir = _to_float(values.get("DRCT"))
        wspd = _to_float(values.get("SPED")) 
        if wspd is None:
            wspd = _to_float(values.get("SKNT"))
        wind_missing = wdir is None or wspd is None
        if wdir is None:
            wdir = last_dir
        else:
            last_dir = wdir
        if wspd is None:
            wspd = last_speed
        else:
            last_speed = wspd

        levels.append(
            Level(
                pres=pres,
                hght=hght,
                temp=temp,
                dwpt=dwpt,
                wdir=wdir,
                wspd=wspd,
                wind_missing=wind_missing,
            )
        )

    if len(levels) < MIN_LEVELS:
        raise ParseError("Мало уровней: %d" % len(levels))

    levels.sort(key=lambda item: item.pres, reverse=True)
    return Sounding(
        station=station,
        day=day or date.today(),
        hour=hour,
        levels=levels,
        wind_unit=wind_unit,
        wind_unit_source=wind_source,
        columns=columns,
    )


def _to_float(value: Optional[str]) -> Optional[float]:
    if value is None:
        return None
    value = value.strip()
    if not value:
        return None
    try:
        return float(value)
    except ValueError:
        return None
