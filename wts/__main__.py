"""Запуск: python -m wts [--host 127.0.0.1] [--port 8770]."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from .server import default_data_dir, serve


def env_default(name: str, fallback: str) -> str:
    return os.environ.get(name, fallback)


def main() -> None:
    parser = argparse.ArgumentParser(description="WtS — массовая загрузка зондов Wyoming для SHARPpy")
    parser.add_argument("--host", default=env_default("WTS_HOST", "127.0.0.1"), help="адрес прослушивания (по умолчанию только loopback)")
    parser.add_argument("--port", type=int, default=int(env_default("WTS_PORT", "8770")), help="порт (по умолчанию 8770)")
    parser.add_argument("--data-dir", default=os.environ.get("WTS_DATA_DIR", ""), help="каталог результатов (по умолчанию %s)" % default_data_dir())
    parser.add_argument("--site-dir", default="", help="каталог сайта с meteolab-lite.html")
    parser.add_argument("--ttl-hours", type=float, default=float(env_default("WTS_TTL_HOURS", "24")), help="сколько часов хранить результаты задач")
    parser.add_argument("--max-jobs", type=int, default=int(env_default("WTS_MAX_JOBS", "8")), help="сколько задач разрешено одновременно")
    parser.add_argument("--open", action="store_true", help="открыть сайт в браузере")
    args = parser.parse_args()

    data_dir = Path(args.data_dir).expanduser() if args.data_dir else None
    site_dir = Path(args.site_dir).expanduser() if args.site_dir else None
    code = serve(
        args.host,
        args.port,
        data_dir,
        site_dir,
        ttl_hours=args.ttl_hours,
        max_jobs=args.max_jobs,
        open_browser=args.open,
    )
    sys.exit(code)


if __name__ == "__main__":
    main()
