#!/usr/bin/env python3
"""
Movie Booking Showtime Watcher.

Executes scraper.js to check whether showtimes for a movie/theatre are active (not gray).
Tracks status in state.json and sends a Telegram alert only when showtime statuses change.
"""

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent
CONFIG_PATH = Path(os.environ.get("CONFIG_PATH", ROOT / "config.json"))
STATE_PATH = Path(os.environ.get("STATE_PATH", ROOT / "state.json"))


def load_json(path, default=None):
    if not path.exists():
        return default
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def save_json(path, data):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)


def load_config():
    cfg = load_json(CONFIG_PATH, default={}) or {}

    # Environment variables override file config (e.g., GitHub Actions secrets)
    env_map = {
        "TARGET_URL": "target_url",
        "THEATRE": "theatre",
        "MOVIE": "movie",
        "REQUESTED_DATE": "requested_date",
        "TELEGRAM_BOT_TOKEN": "telegram_bot_token",
        "TELEGRAM_CHAT_ID": "telegram_chat_id",
        "CITY": "city",
        "MOVIE_SLUG": "movie_slug",
        "MOVIE_ID": "movie_id",
    }
    for env_key, cfg_key in env_map.items():
        if os.environ.get(env_key):
            cfg[cfg_key] = os.environ[env_key]

    required = ["telegram_bot_token", "telegram_chat_id"]
    missing = [k for k in required if not cfg.get(k)]
    if missing:
        sys.exit(f"Missing required config: {', '.join(missing)}")
    return cfg


def send_telegram(token, chat_id, text):
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    resp = requests.post(
        url,
        json={"chat_id": chat_id, "text": text, "disable_web_page_preview": False},
        timeout=30,
    )
    resp.raise_for_status()


def run_spiderman_scraper(cfg):
    """Executes scraper.js with config.json and --json output mode."""
    scraper_js = ROOT / "scraper.js"
    if not scraper_js.exists():
        print(f"[scraper] {scraper_js} not found.")
        return None

    cmd = [
        "node",
        str(scraper_js),
        "--config", str(CONFIG_PATH),
        "--json"
    ]

    try:
        proc = subprocess.run(
            cmd,
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=180
        )
        if proc.returncode != 0:
            print(f"[spiderman_scraper] process exited with code {proc.returncode}")
            if proc.stderr:
                print(f"[spiderman_scraper stderr]: {proc.stderr[:500]}")
            return None

        out_text = proc.stdout.strip()
        if not out_text:
            print("[spiderman_scraper] stdout was empty")
            return None

        data = json.loads(out_text)
        return data

    except Exception as exc:
        print(f"[spiderman_scraper] failed to execute node process: {exc}")
        return None


def process_scraper_result(scraper_data, cfg):
    """Processes scraper JSON into summary dict. Maps gray showtimes -> False, non-gray -> True."""
    if not scraper_data or not scraper_data.get("success"):
        return {
            "available": False,
            "shows_status": {},
            "shows_summary": []
        }

    overall_available = False
    shows_status = {}
    shows_summary = []
    date_results = scraper_data.get("dateResults", [])
    multi_date = len(date_results) > 1

    for d_res in date_results:
        d_str = d_res.get("date", "")

        for show in d_res.get("showResults", []):
            time_str = show.get("time", "")
            status = show.get("status", "")
            
            if "isGray" in show:
                is_gray = show["isGray"]
            else:
                is_gray = (status == "Disabled (Gray)" or "Disabled" in status or "Gray" in status)

            # gray -> false, not gray -> true
            is_available = not is_gray
            if is_available:
                overall_available = True

            key = f"{d_str}_{time_str}" if multi_date else time_str
            shows_status[key] = is_available

            status_label = "Not Gray (true)" if is_available else "Gray (false)"
            shows_summary.append(f"• {time_str}: {status_label}")

    return {
        "available": overall_available,
        "shows_status": shows_status,
        "shows_summary": shows_summary,
        "raw": scraper_data
    }


def main():
    cfg = load_config()
    state = load_json(STATE_PATH, default={}) or {}

    target_desc = cfg.get("venue_label") or cfg.get("theatre") or cfg.get("requested_date", "target")
    label = f"{cfg.get('movie', 'movie')} @ {target_desc}"

    print(f"[{label}] Running showtime watcher...")

    scraper_raw = run_spiderman_scraper(cfg)
    if not scraper_raw:
        print(f"[{label}] scraper execution returned no data.")
        return 0

    summary = process_scraper_result(scraper_raw, cfg)
    curr_shows_status = summary["shows_status"]
    prev_shows_status = state.get("shows_status", None)

    is_different = (curr_shows_status != prev_shows_status)

    print(f"[{label}] Current showtimes status: {curr_shows_status}")
    print(f"[{label}] Previous showtimes status: {prev_shows_status}")
    print(f"[{label}] Data changed: {is_different}")

    if is_different and curr_shows_status:
        rd = cfg.get("requested_date", "")
        pretty = f"{rd[6:8]}-{rd[4:6]}-{rd[0:4]}" if len(rd) == 8 else rd
        venue = cfg.get("venue_label") or cfg.get("theatre") or cfg.get("venue_code") or ""
        venue_line = f"Theatre: {venue}\n" if venue else ""
        target_url = cfg.get("target_url") or f"https://in.bookmyshow.com/movies/{cfg.get('city','hyderabad')}/{cfg.get('movie_slug','movie')}/buytickets/{cfg.get('movie_id','')}/{rd}"

        shows_text = "\n".join(summary["shows_summary"]) if summary["shows_summary"] else "No showtimes found."

        msg = (
            f"🎬 Showtime Status Update!\n\n"
            f"Movie: {cfg.get('movie', 'Movie')}\n"
            f"{venue_line}"
            f"Date: {pretty}\n\n"
            f"⏰ Showtimes Status:\n"
            f"{shows_text}\n\n"
            f"Book here: {target_url}"
        )
        send_telegram(cfg["telegram_bot_token"], cfg["telegram_chat_id"], msg)
        print(f"[{label}] notification sent to Telegram (status changed)")
    else:
        print(f"[{label}] no notification sent (data unchanged from last state)")

    # Persist state if different
    if is_different:
        state["shows_status"] = curr_shows_status
        state["available"] = summary["available"]
        state["checked_at"] = int(time.time())
        save_json(STATE_PATH, state)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
