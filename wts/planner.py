"""Планирование задач загрузки: станции, даты, сроки, быстрые диапазоны."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from typing import Iterable, List, Sequence, Tuple

MONTHS_RU = [
    "Январь",
    "Февраль",
    "Март",
    "Апрель",
    "Май",
    "Июнь",
    "Июль",
    "Август",
    "Сентябрь",
    "Октябрь",
    "Ноябрь",
    "Декабрь",
]

STATIONS: List[Tuple[str, str]] = [
    ("Якутск", "24959"),
    ("Оймякон", "24944"),
    ("Тикси", "24691"),
    ("Верхоянск", "24266"),
    ("Среднеколымск", "25123"),
    ("Алдан", "24982"),
    ("Мирный", "89471"),
    ("Ленск", "24804"),
    ("Нерюнгри", "24856"),
    ("Черский", "25173"),
    ("Певек", "25034"),
    ("Анадырь", "25563"),
    ("Магадан", "25913"),
    ("Хабаровск", "31735"),
    ("Москва", "27612"),
    ("Санкт-Петербург", "26063"),
    ("Новосибирск", "29634"),
    ("Иркутск", "30710"),
    ("Владивосток", "31960"),
]

VALID_HOURS = ("00", "12")
MAX_TARGETS = 5000
MAX_RANGE_DAYS = 3660


class ValidationError(ValueError):
    """Параметры задачи не проходят проверку."""


@dataclass(frozen=True)
class Target:
    day: date
    hour: str


def station_options() -> List[dict]:
    return [{"name": name, "wmo": wmo} for name, wmo in STATIONS]


def station_name(wmo: str) -> str:
    for name, code in STATIONS:
        if code == wmo:
            return name
    return ""


def validate_station(value: object) -> str:
    text = str(value or "").strip()
    if not text:
        raise ValidationError("Не указан WMO ID станции")
    if not text.isdigit() or not 1 <= len(text) <= 5:
        raise ValidationError("WMO ID должен состоять из 1–5 цифр")
    return text


def parse_date(value: object, label: str) -> date:
    """Принимает 'YYYY-MM-DD', {y,m,d} или [y,m,d]."""
    if isinstance(value, date):
        return value
    if isinstance(value, dict):
        try:
            return date(int(value["y"]), int(value["m"]), int(value["d"]))
        except (KeyError, TypeError, ValueError) as exc:
            raise ValidationError("Некорректная %s: ожидается год, месяц, день" % label) from exc
    if isinstance(value, (list, tuple)) and len(value) == 3:
        try:
            return date(int(value[0]), int(value[1]), int(value[2]))
        except (TypeError, ValueError) as exc:
            raise ValidationError("Некорректная %s" % label) from exc
    text = str(value or "").strip()
    if not text:
        raise ValidationError("Не указана %s" % label)
    try:
        return date.fromisoformat(text)
    except ValueError as exc:
        raise ValidationError("Некорректная %s: %s" % (label, text)) from exc


def normalize_hours(values: object) -> List[str]:
    if values is None:
        values = list(VALID_HOURS)
    if isinstance(values, str):
        values = [values]
    if not isinstance(values, (list, tuple, set)):
        raise ValidationError("Сроки зондирования должны быть списком")
    hours: List[str] = []
    for raw in values:
        text = str(raw).strip()
        if text.endswith("Z"):
            text = text[:-1]
        text = text.zfill(2)
        if text not in VALID_HOURS:
            raise ValidationError("Срок %s не поддерживается (доступны 00 и 12 UTC)" % raw)
        if text not in hours:
            hours.append(text)
    if not hours:
        raise ValidationError("Выберите хотя бы один срок зондирования (00 или 12 UTC)")
    hours.sort()
    return hours


def iter_targets(start: date, end: date, hours: Sequence[str]) -> List[Target]:
    if start > end:
        raise ValidationError("Начальная дата позже конечной")
    span = (end - start).days + 1
    if span > MAX_RANGE_DAYS:
        raise ValidationError("Слишком длинный период: %d дней (максимум %d)" % (span, MAX_RANGE_DAYS))
    targets: List[Target] = []
    current = start
    while current <= end:
        for hour in hours:
            targets.append(Target(current, hour))
        current += timedelta(days=1)
    if len(targets) > MAX_TARGETS:
        raise ValidationError(
            "Слишком много зондов: %d (максимум %d). Сократите период." % (len(targets), MAX_TARGETS)
        )
    return targets


def last_month(today: date) -> Tuple[date, date]:
    end = date(today.year, today.month, today.day)
    if today.month == 1:
        start = date(today.year - 1, 12, 1)
    else:
        start = date(today.year, today.month - 1, 1)
    return start, end


def last_year(today: date) -> Tuple[date, date]:
    return date(today.year - 1, today.month, today.day), date(today.year, today.month, today.day)


def organize_parts(target: Target, organize: bool) -> List[str]:
    if not organize:
        return []
    return [
        "%04d" % target.day.year,
        "%02d - %s" % (target.day.month, MONTHS_RU[target.day.month - 1]),
        "%s UTC" % target.hour,
    ]


def validate_workers(value: object) -> int:
    try:
        workers = int(value)
    except (TypeError, ValueError) as exc:
        raise ValidationError("Число потоков должно быть целым числом") from exc
    if not 1 <= workers <= 10:
        raise ValidationError("Число потоков: от 1 до 10")
    return workers


def validate_delay(value: object) -> float:
    try:
        delay = float(value)
    except (TypeError, ValueError) as exc:
        raise ValidationError("Задержка должна быть числом") from exc
    if delay < 0 or delay > 30:
        raise ValidationError("Задержка: от 0 до 30 секунд")
    return round(delay, 2)
