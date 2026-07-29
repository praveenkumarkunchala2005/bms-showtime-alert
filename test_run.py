#!/usr/bin/env python3
"""Quick local test — runs spiderman_scraper & detection without Telegram."""

import json
import os
import sys
from pathlib import Path

# Provide dummy Telegram creds so load_config() doesn't exit
os.environ.setdefault("TELEGRAM_BOT_TOKEN", "dummy")
os.environ.setdefault("TELEGRAM_CHAT_ID", "dummy")

from poller import load_config, run_spiderman_scraper, process_scraper_result, load_json, save_json, STATE_PATH

def main():
    print("=" * 60)
    print("Movie-Alert — Local Test (spiderman_scraper)")
    print("=" * 60)

    cfg = load_config()
    print(f"\n✅ Config loaded successfully")
    print(f"   Movie        : {cfg.get('movie')}")
    print(f"   Date         : {cfg.get('requested_date')}")
    print(f"   City         : {cfg.get('city')}")
    print(f"   Movie Slug   : {cfg.get('movie_slug')}")
    print(f"   Movie ID     : {cfg.get('movie_id')}")
    print(f"   Venue Label  : {cfg.get('venue_label')} ({cfg.get('venue_code')})")
    print(f"   Detector     : {cfg.get('detector')}")

    print(f"\n⏳ Running spiderman_scraper...")
    scraper_raw = run_spiderman_scraper(cfg)
    if not scraper_raw:
        print("❌ spiderman_scraper returned no data or failed.")
        return 1

    summary = process_scraper_result(scraper_raw, cfg)

    print(f"\n✅ Scraper finished successfully!")
    print(f"   Overall Available       : {summary['available']}")
    print(f"   Total Shows Discovered  : {len(summary['shows_status'])}")

    print("\n📋 Showtime Gray Status Breakdown:")
    for line in summary['shows_summary']:
        print(f"   {line}")

    state = load_json(STATE_PATH, default={}) or {}
    prev_shows_status = state.get("shows_status", None)
    curr_shows_status = summary["shows_status"]

    is_different = (curr_shows_status != prev_shows_status)

    print(f"\n   Previous state in state.json: {prev_shows_status}")
    print(f"   Current state from scraper  : {curr_shows_status}")
    print(f"   Is Data Different           : {is_different}")

    if is_different:
        print("   → Data CHANGED! Would send Telegram alert for every show time.")
        state["shows_status"] = curr_shows_status
        state["available"] = summary["available"]
        save_json(STATE_PATH, state)
        print("   → Updated state.json successfully.")
    else:
        print("   → Data UNCHANGED! No alert required.")

    print(f"\n{'=' * 60}")
    print("Test complete.")
    return 0

if __name__ == "__main__":
    sys.exit(main())
