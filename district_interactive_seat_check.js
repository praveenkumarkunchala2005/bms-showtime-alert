#!/usr/bin/env node
"use strict";

import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

const BASE_URL = "https://www.district.in";
const APP_TYPE = "ed_web";
const DISTRICT_QUERY_DEFAULTS = {
  version: 3,
  site_id: 1,
  channel: "ANDROIDAPPINSIDER",
  child_site_id: 1,
  platform: "district",
};

function todayInIST() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function isValidDate(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const dt = new Date(`${dateStr}T00:00:00+05:30`);
  return !Number.isNaN(dt.getTime());
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(`Non-JSON response from ${url}: ${text.slice(0, 200)}`);
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${url}: ${JSON.stringify(parsed).slice(0, 300)}`);
    }
    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

function baseHeaders(extra = {}) {
  return {
    "content-type": "application/json",
    "x-app-type": APP_TYPE,
    "x-request-id": "district-interactive-seat-check",
    "user-agent": "Mozilla/5.0",
    ...extra,
  };
}

async function getGuestToken() {
  const json = await fetchJson(`${BASE_URL}/gw/auth/skip_login`, {
    method: "POST",
    headers: baseHeaders(),
    body: "{}",
  });
  const token = json?.token?.guest_token || "";
  if (!token) throw new Error("Could not obtain District guest token.");
  return token;
}

async function getCities(token) {
  const json = await fetchJson(`${BASE_URL}/gw/consumer/movies/v3/cities`, {
    method: "GET",
    headers: baseHeaders({ "x-guest-token": token }),
  });
  return json?.data?.cities || [];
}

async function getMoviesByCity(token, cityKey) {
  const url = `${BASE_URL}/gw/consumer/movies/v3/movies?city=${encodeURIComponent(cityKey)}`;
  const json = await fetchJson(url, {
    method: "GET",
    headers: baseHeaders({ "x-guest-token": token }),
  });
  return json?.data?.movies || [];
}

async function getCinemasByCity(token, cityKey) {
  const url = `${BASE_URL}/gw/consumer/movies/v3/cinemas?city=${encodeURIComponent(cityKey)}`;
  const json = await fetchJson(url, {
    method: "GET",
    headers: baseHeaders({ "x-guest-token": token }),
  });
  return json?.data?.cinemas || json?.meta?.cinemas || [];
}

async function getMovieSessionsV3(token, { cityKey, movieCode, date }) {
  const url =
    `${BASE_URL}/gw/consumer/movies/v3/movie?meta=1&reqData=1` +
    `&city=${encodeURIComponent(cityKey)}` +
    `&movieCode=${encodeURIComponent(movieCode)}` +
    `&date=${encodeURIComponent(date)}`;

  return fetchJson(url, {
    method: "GET",
    headers: baseHeaders({ "x-guest-token": token }),
  });
}

function normalizeV5Sessions(v5Json) {
  const nearby = v5Json?.pageData?.nearbyCinemas || [];
  const far = v5Json?.pageData?.farCinemas || [];
  const all = [...nearby, ...far];

  const sessionsByCinema = {};
  const cinemas = [];
  for (const cinema of all) {
    const cid = String(cinema?.id || "");
    if (!cid) continue;
    sessionsByCinema[cid] = Array.isArray(cinema?.sessions) ? cinema.sessions : [];
    cinemas.push({
      id: cinema?.id,
      name: cinema?.cinemaInfo?.name || cinema?.cinemaInfo?.label || "",
      label: cinema?.cinemaInfo?.name || cinema?.cinemaInfo?.label || "",
      address: cinema?.cinemaInfo?.address || "",
      lat: cinema?.cinemaInfo?.latitude,
      lon: cinema?.cinemaInfo?.longitude,
      cityId: cinema?.cinemaInfo?.cityId,
      city: cinema?.cinemaInfo?.city,
      chainKey: cinema?.cinemaInfo?.chainKey,
      sessionCount: sessionsByCinema[cid].length,
      amenities: cinema?.amenities || [],
    });
  }

  const movie = v5Json?.meta?.movie || {};
  const movies = [
    {
      id: movie?.id || movie?.movie_id,
      frmtId: movie?.frmtId || movie?.frmt_id,
      name: movie?.name || movie?.label || "",
      contentId: movie?.content_id || movie?.contentId,
      lang: movie?.language || movie?.lang || "",
    },
  ];

  return {
    serverTime: v5Json?.serverTime,
    meta: {
      ...(v5Json?.meta || {}),
      cinemas,
      movies,
      sourceEndpoint: "v5",
    },
    data: v5Json?.data || {},
    pageData: {
      ...(v5Json?.pageData || {}),
      sessions: sessionsByCinema,
    },
  };
}

async function getMovieSessionsV5(token, { cityKey, movieCode, date, contentId, latitude, longitude }) {
  const params = new URLSearchParams();
  Object.entries(DISTRICT_QUERY_DEFAULTS).forEach(([k, v]) => params.set(k, String(v)));
  params.set("movieCode", String(movieCode));
  params.set("city_key", String(cityKey));
  params.set("content_id", String(contentId));
  if (date) params.set("date", String(date));
  params.set("latitude", String(latitude));
  params.set("longitude", String(longitude));
  params.set("cinemaOrderLogic", "3");

  const url = `${BASE_URL}/gw/consumer/movies/v5/movie?${params.toString()}`;
  const v5Json = await fetchJson(url, {
    method: "GET",
    headers: baseHeaders({ "x-guest-token": token }),
  });
  return normalizeV5Sessions(v5Json);
}

async function getMovieSessions(token, { cityKey, movieCode, date, contentId, latitude, longitude }) {
  if (
    contentId !== undefined &&
    contentId !== null &&
    contentId !== "" &&
    latitude !== undefined &&
    latitude !== null &&
    longitude !== undefined &&
    longitude !== null
  ) {
    try {
      const viaV5 = await getMovieSessionsV5(token, {
        cityKey,
        movieCode,
        date,
        contentId,
        latitude,
        longitude,
      });
      const count = Object.keys(viaV5?.pageData?.sessions || {}).length;
      if (count > 0) return viaV5;
    } catch (err) {
      // Fall through to v3.
    }
  }
  const viaV3 = await getMovieSessionsV3(token, { cityKey, movieCode, date });
  return {
    ...viaV3,
    meta: {
      ...(viaV3?.meta || {}),
      sourceEndpoint: "v3",
    },
  };
}

async function getSeatMap(token, payload) {
  return fetchJson(`${BASE_URL}/gw/consumer/movies/v1/select-seat`, {
    method: "POST",
    headers: baseHeaders({ "x-guest-token": token }),
    body: JSON.stringify(payload),
  });
}

function includesInsensitive(haystack, needle) {
  return String(haystack || "").toLowerCase().includes(String(needle || "").toLowerCase());
}

async function selectFromList(rl, { title, items, toLabel, searchable, pageSize = 20 }) {
  if (!items || items.length === 0) {
    throw new Error(`No items available for ${title}.`);
  }

  let query = "";
  while (true) {
    const filtered = query
      ? items.filter((item) => searchable(item).some((field) => includesInsensitive(field, query)))
      : items;

    if (filtered.length === 0) {
      query = await rl.question(`\nNo matches for "${query}". Enter a new ${title.toLowerCase()} search: `);
      query = query.trim();
      continue;
    }

    const shown = filtered.slice(0, pageSize);
    console.log(`\n${title} matches: ${filtered.length}`);
    shown.forEach((item, index) => {
      console.log(`${index + 1}. ${toLabel(item)}`);
    });
    if (filtered.length > pageSize) {
      console.log(`Showing first ${pageSize}. Narrow with a search term if needed.`);
    }

    const answer = (await rl.question(
      `Select ${title.toLowerCase()} number (1-${shown.length}) or type search text (/all to reset): `
    )).trim();

    if (/^\d+$/.test(answer)) {
      const idx = Number(answer) - 1;
      if (idx >= 0 && idx < shown.length) {
        return shown[idx];
      }
      console.log("Invalid selection index.");
      continue;
    }

    if (answer.toLowerCase() === "/all") {
      query = "";
      continue;
    }

    query = answer;
  }
}

function normalizeShowTime(rawInput) {
  const raw = String(rawInput || "").trim();
  if (!raw) return raw;

  const noTzShort = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw);
  const noTzLong = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(raw);
  if (!noTzShort && !noTzLong) return raw;

  // District often returns timezone-less values that map to UTC clock time.
  // Appending Z keeps IST conversion correct (e.g. 11:45 -> 17:15 IST).
  return noTzShort ? `${raw}:00Z` : `${raw}Z`;
}

function formatShowTime(showTime, sourceEndpoint = "v3") {
  if (!showTime) return "Unknown time";
  const raw = String(showTime).trim();
  const normalized = normalizeShowTime(raw);

  const dt = new Date(normalized);
  if (Number.isNaN(dt.getTime())) return raw;

  const datePart = dt.toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
  const timePart = dt
    .toLocaleTimeString("en-IN", {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    })
    .toUpperCase();

  return `${datePart} ${timePart} IST`;
}

function buildTheatersFromSessions(sessionJson) {
  const sessionsByCinema = sessionJson?.pageData?.sessions || {};
  const cinemaMeta = sessionJson?.meta?.cinemas || [];
  const metaMap = new Map(cinemaMeta.map((c) => [String(c.id), c]));

  const theaters = Object.entries(sessionsByCinema)
    .filter(([, sessions]) => Array.isArray(sessions) && sessions.length > 0)
    .map(([cinemaId, sessions]) => {
      const meta = metaMap.get(String(cinemaId)) || {};
      const availNow = sessions.reduce((sum, s) => sum + Number(s?.avail || 0), 0);
      return {
        cinemaId: String(cinemaId),
        meta,
        sessions: sessions.slice().sort((a, b) => String(a.showTime).localeCompare(String(b.showTime))),
        availNow,
      };
    })
    .sort((a, b) => String(a.meta?.name || a.meta?.label || "").localeCompare(String(b.meta?.name || b.meta?.label || "")));

  return theaters;
}

function analyzeChains(names) {
  const cleanNames = names.filter(Boolean).map((n) => String(n));
  const pvr = cleanNames.filter((n) => /\bpvr\b/i.test(n));
  const inox = cleanNames.filter((n) => /\binox\b/i.test(n));
  return {
    total: cleanNames.length,
    pvrCount: pvr.length,
    inoxCount: inox.length,
    pvrSample: pvr.slice(0, 5),
    inoxSample: inox.slice(0, 5),
  };
}

function analyzeSeatLayout(seatJson) {
  const areas = seatJson?.seatLayout?.colAreas?.objArea || [];

  let totalSeats = 0;
  let availableSeats = 0;
  let unavailableSeats = 0;
  const rows = [];

  for (const area of areas) {
    const areaName = area?.AreaDesc || area?.AreaCode || "Area";
    const areaRows = area?.objRow || [];

    for (const row of areaRows) {
      const rowName = String(row?.PhyRowId || row?.GridRowId || "NA");
      const seats = row?.objSeat || [];
      let rowAvailable = 0;
      let rowUnavailable = 0;
      const availableSeatNumbers = [];

      for (const seat of seats) {
        const status = String(seat?.SeatStatus ?? "");
        const seatNum = String(
          seat?.displaySeatNumber ?? seat?.StrSeatNumber ?? seat?.seatNumber ?? seat?.GridSeatNum ?? ""
        );

        totalSeats += 1;
        if (status === "0") {
          availableSeats += 1;
          rowAvailable += 1;
          if (seatNum) availableSeatNumbers.push(seatNum);
        } else {
          unavailableSeats += 1;
          rowUnavailable += 1;
        }
      }

      if (seats.length > 0) {
        rows.push({
          areaName,
          rowName,
          total: seats.length,
          available: rowAvailable,
          unavailable: rowUnavailable,
          availableSeatNumbers,
        });
      }
    }
  }

  rows.sort((a, b) => {
    const areaCmp = a.areaName.localeCompare(b.areaName);
    if (areaCmp !== 0) return areaCmp;
    return a.rowName.localeCompare(b.rowName, undefined, { numeric: true, sensitivity: "base" });
  });

  const rowsWithUnsoldSeats = rows.filter((r) => r.available > 0);
  const fullySoldRows = rows.filter((r) => r.available === 0);

  return {
    totalSeats,
    availableSeats,
    unavailableSeats,
    rows,
    rowsWithUnsoldSeats,
    fullySoldRows,
  };
}

async function main() {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  try {
    console.log("Fetching guest token...");
    const token = await getGuestToken();

    console.log("Loading cities...");
    const cities = await getCities(token);
    const city = await selectFromList(rl, {
      title: "City",
      items: cities.sort((a, b) => String(a.name).localeCompare(String(b.name))),
      toLabel: (c) => `${c.name} (${c.value})`,
      searchable: (c) => [c.name, c.value, ...(c.searchable || [])],
    });
    console.log(`Selected city: ${city.name} (${city.value})`);

    console.log("Loading movies for selected city...");
    const movies = await getMoviesByCity(token, city.value);
    const movie = await selectFromList(rl, {
      title: "Movie",
      items: movies.sort((a, b) => String(a.name).localeCompare(String(b.name))),
      toLabel: (m) => `${m.name} | ${m.lang || "NA"} | sessions: ${m.totalSessionCount ?? "NA"}`,
      searchable: (m) => [m.name, m.label, m.lang, m.id, m.frmtId],
    });
    console.log(`Selected movie: ${movie.name} (${movie.frmtId})`);

    const defaultDate = todayInIST();
    let date = (await rl.question(`Show date YYYY-MM-DD (default ${defaultDate}): `)).trim();
    if (!date) date = defaultDate;
    while (!isValidDate(date)) {
      date = (await rl.question("Invalid date format. Enter YYYY-MM-DD: ")).trim();
    }

    console.log(`Loading sessions for ${date}...`);
    const sessionsJson = await getMovieSessions(token, {
      cityKey: city.value,
      movieCode: movie.frmtId,
      date,
      contentId: movie.contentId,
      latitude: city.lat,
      longitude: city.lon,
    });
    console.log(`Sessions source endpoint: ${sessionsJson?.meta?.sourceEndpoint || "unknown"}`);

    let cityCinemas = [];
    try {
      cityCinemas = await getCinemasByCity(token, city.value);
    } catch (err) {
      console.log(`Could not load city-level cinemas for chain check: ${err.message || err}`);
    }

    const theaters = buildTheatersFromSessions(sessionsJson);

    const cityCinemaNames = cityCinemas.map((c) => c?.name || c?.label || "").filter(Boolean);
    const sessionCinemaNames = (sessionsJson?.meta?.cinemas || [])
      .map((c) => c?.name || c?.label || "")
      .filter(Boolean);
    const cityChainStats = analyzeChains(cityCinemaNames);
    const sessionChainStats = analyzeChains(sessionCinemaNames);
    const isPVRCinemaRemoved = Boolean(sessionsJson?.meta?.isPVRCinemaRemoved);

    console.log("\nChain visibility check:");
    console.log(
      `- City catalog cinemas: ${cityChainStats.total} | PVR: ${cityChainStats.pvrCount} | INOX: ${cityChainStats.inoxCount}`
    );
    console.log(
      `- Selected movie/date cinemas: ${sessionChainStats.total} | PVR: ${sessionChainStats.pvrCount} | INOX: ${sessionChainStats.inoxCount}`
    );
    console.log(`- API flag isPVRCinemaRemoved: ${isPVRCinemaRemoved}`);
    if (isPVRCinemaRemoved && cityChainStats.pvrCount > 0 && sessionChainStats.pvrCount === 0) {
      console.log(
        "- District is excluding PVR chain for this movie/date response; this is upstream API behavior."
      );
    }
    if (
      cityChainStats.inoxCount > 0 &&
      sessionChainStats.inoxCount === 0 &&
      sessionChainStats.total > 0
    ) {
      console.log(
        "- INOX is also absent in selected movie/date sessions despite city availability."
      );
    }

    const visibleCinemaIdSet = new Set(theaters.map((t) => String(t.cinemaId)));
    const blockedChainCinemas = cityCinemas
      .filter((c) => /\bpvr\b|\binox\b/i.test(String(c?.name || c?.label || "")))
      .filter((c) => !visibleCinemaIdSet.has(String(c?.id)))
      .map((c) => ({
        blocked: true,
        cinemaId: String(c.id),
        meta: c,
        sessions: [],
        availNow: 0,
      }))
      .sort((a, b) =>
        String(a.meta?.name || a.meta?.label || "").localeCompare(String(b.meta?.name || b.meta?.label || ""))
      );

    if (blockedChainCinemas.length > 0) {
      const blockedNames = blockedChainCinemas
        .map((c) => c.meta?.name || c.meta?.label || c.cinemaId)
        .slice(0, 8)
        .join(" | ");
      console.log(
        `- Blocked chain cinemas hidden from sessions: ${blockedChainCinemas.length}`
      );
      console.log(`- Sample blocked: ${blockedNames}`);
    }

    if (theaters.length === 0) {
      if (blockedChainCinemas.length > 0) {
        console.log(
          "No selectable theaters found. District is exposing only blocked chain theaters for this movie/date in this city."
        );
      } else {
        console.log("No theaters found for this movie/city/date.");
      }
      return;
    }

    const theaterItems = [...theaters, ...blockedChainCinemas];
    let theater = await selectFromList(rl, {
      title: "Theater",
      items: theaterItems,
      toLabel: (t) =>
        t.blocked
          ? `${t.meta?.name || t.meta?.label || `Cinema ${t.cinemaId}`} | BLOCKED by District API`
          : `${t.meta?.name || t.meta?.label || `Cinema ${t.cinemaId}`} | shows: ${t.sessions.length} | avail now: ${t.availNow}`,
      searchable: (t) => [t.meta?.name, t.meta?.label, t.meta?.address, t.cinemaId],
    });

    while (theater.blocked) {
      console.log(
        `Selected theater is blocked by District API for this movie/date: ${theater.meta?.name || theater.meta?.label || theater.cinemaId}`
      );
      console.log("Choose a non-blocked theater to continue seat analysis. Type /all to reset search.");
      theater = await selectFromList(rl, {
        title: "Theater",
        items: theaterItems,
        toLabel: (t) =>
          t.blocked
            ? `${t.meta?.name || t.meta?.label || `Cinema ${t.cinemaId}`} | BLOCKED by District API`
            : `${t.meta?.name || t.meta?.label || `Cinema ${t.cinemaId}`} | shows: ${t.sessions.length} | avail now: ${t.availNow}`,
        searchable: (t) => [t.meta?.name, t.meta?.label, t.meta?.address, t.cinemaId],
      });
    }
    console.log(`Selected theater: ${theater.meta?.name || theater.meta?.label || theater.cinemaId}`);

    const session = await selectFromList(rl, {
      title: "Show",
      items: theater.sessions,
      toLabel: (s) => {
        const areaSnippet = (s.areas || [])
          .slice(0, 3)
          .map((a) => `${a.label}:${a.sAvail}/${a.sTotal}`)
          .join(", ");
        return `${formatShowTime(s.showTime, sessionsJson?.meta?.sourceEndpoint)} | avail ${s.avail}/${s.total} | ${s.scrnFmt || "NA"}${areaSnippet ? ` | ${areaSnippet}` : ""}`;
      },
      searchable: (s) => [s.showTime, s.scrnFmt, s.lang, s.sid, s.audi],
    });

    const selectedMovieMeta = (sessionsJson?.meta?.movies || [])[0] || {};
    const payload = {
      cinemaId: Number(theater.cinemaId),
      sessionId: String(session.sid),
      providerId: session.pid,
      screenOnTop: true,
      freeSeating: Boolean(session.freeSeating || session.sType === 1),
      screenFormat: session.scrnFmt || "2D",
      moviecode: session.mid,
      config: { socialDistancing: 1 },
      contentId: String(selectedMovieMeta.contentId || movie.contentId || ""),
    };

    console.log("Fetching seat map...");
    const seatJson = await getSeatMap(token, payload);
    if (seatJson?.error || seatJson?.status === "STATUS_FAILURE") {
      throw new Error(`Seat-map API error: ${JSON.stringify(seatJson).slice(0, 400)}`);
    }

    const analysis = analyzeSeatLayout(seatJson);

    console.log("\n===== Seat Availability Report =====");
    console.log(`City: ${city.name} (${city.value})`);
    console.log(`Movie: ${movie.name}`);
    console.log(`Theater: ${theater.meta?.name || theater.meta?.label || theater.cinemaId}`);
    console.log(`Show: ${formatShowTime(session.showTime, sessionsJson?.meta?.sourceEndpoint)} (sessionId=${session.sid})`);
    console.log(`Seats left (seat map): ${analysis.availableSeats} / ${analysis.totalSeats}`);
    console.log(`Unavailable/sold (seat map): ${analysis.unavailableSeats}`);
    console.log(`Rows with unsold seats: ${analysis.rowsWithUnsoldSeats.length}`);
    console.log(`Fully sold rows: ${analysis.fullySoldRows.length}`);
    console.log(
      "SeatStatus assumption: 0 = available/unsold, non-zero = unavailable."
    );

    if (analysis.rowsWithUnsoldSeats.length === 0) {
      console.log("\nNo rows with unsold seats were found.");
      return;
    }

    console.log("\nRows with unsold seats:");
    for (const row of analysis.rowsWithUnsoldSeats) {
      const preview = row.availableSeatNumbers.slice(0, 20).join(",");
      const extra = row.availableSeatNumbers.length > 20 ? ` ... +${row.availableSeatNumbers.length - 20} more` : "";
      const seatPart = preview ? ` | seat nos: ${preview}${extra}` : "";
      console.log(
        `- ${row.areaName} | Row ${row.rowName}: ${row.available}/${row.total} unsold${seatPart}`
      );
    }
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error(`\nError: ${err.message || err}`);
  process.exit(1);
});
