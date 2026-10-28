#!/usr/bin/env node
"use strict";

import fs from "node:fs/promises";

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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ""))) return false;
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
    } catch {
      throw new Error(`Non-JSON response from ${url}: ${text.slice(0, 200)}`);
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${url}: ${JSON.stringify(parsed).slice(0, 350)}`);
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
    "x-request-id": `district-dataset-${Date.now()}`,
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
      city: cinema?.cinemaInfo?.city,
      chainKey: cinema?.cinemaInfo?.chainKey,
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
    ...v5Json,
    meta: {
      ...(v5Json?.meta || {}),
      cinemas,
      movies,
      sourceEndpoint: "v5",
    },
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
  params.set("date", String(date));
  params.set("latitude", String(latitude));
  params.set("longitude", String(longitude));
  params.set("cinemaOrderLogic", "3");

  const url = `${BASE_URL}/gw/consumer/movies/v5/movie?${params}`;
  const json = await fetchJson(url, {
    method: "GET",
    headers: baseHeaders({ "x-guest-token": token }),
  });
  return normalizeV5Sessions(json);
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
    } catch {
      // fallback to v3
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

function normalizeRowOrder(value) {
  const v = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_")
    .replace(/\s+/g, "_");
  if (!v || v === "api") return "api";
  if (v === "a_to_z_top_to_bottom" || v === "az_top_to_bottom" || v === "asc") {
    return "a_to_z_top_to_bottom";
  }
  if (v === "a_to_z_bottom_to_top" || v === "az_bottom_to_top" || v === "desc") {
    return "a_to_z_bottom_to_top";
  }
  throw new Error(
    `Invalid row order "${value}". Use one of: api, a_to_z_top_to_bottom, a_to_z_bottom_to_top`
  );
}

function normalizeShowTime(rawInput) {
  const raw = String(rawInput || "").trim();
  if (!raw) return raw;

  const noTzShort = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw);
  const noTzLong = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(raw);
  if (!noTzShort && !noTzLong) return raw;
  return noTzShort ? `${raw}:00Z` : `${raw}Z`;
}

function showTimeISTDateTime(showTime) {
  const normalized = normalizeShowTime(showTime);
  const dt = new Date(normalized);
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
}

function showTimeISTHHMM(showTime) {
  const dt = showTimeISTDateTime(showTime);
  if (!dt) return "";
  return dt.toLocaleTimeString("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatShowTimeIST(showTime) {
  const dt = showTimeISTDateTime(showTime);
  if (!dt) return String(showTime || "Unknown time");
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

function extractRowsInDisplayOrder(seatJson) {
  const areas = seatJson?.seatLayout?.colAreas?.objArea || [];
  const rows = [];
  for (const area of areas) {
    const areaName = area?.AreaDesc || area?.AreaCode || "Area";
    for (const row of area?.objRow || []) {
      const rowName = String(row?.PhyRowId || row?.GridRowId || "").trim();
      if (!rowName) continue;
      const seats = row?.objSeat || [];
      const availableSeatNumbers = [];
      for (const seat of seats) {
        const num = String(
          seat?.displaySeatNumber ?? seat?.StrSeatNumber ?? seat?.seatNumber ?? seat?.GridSeatNum ?? ""
        ).trim();
        if (!num) continue;
        if (String(seat?.SeatStatus ?? "") === "0") availableSeatNumbers.push(num);
      }
      rows.push({
        areaName,
        rowName,
        totalSeats: seats.length,
        availableSeatNumbers,
      });
    }
  }
  return rows;
}

function topTwoThirdRows(rows) {
  if (!rows.length) return [];
  const keep = Math.ceil((rows.length * 2) / 3);
  return rows.slice(0, keep);
}

function rowNameRank(rowName) {
  const raw = String(rowName || "").toUpperCase().trim();
  if (!raw) return Number.POSITIVE_INFINITY;

  const alpha = (raw.match(/[A-Z]+/g) || []).join("");
  const digits = (raw.match(/\d+/g) || []).join("");

  let alphaRank = 0;
  for (const ch of alpha) {
    alphaRank = alphaRank * 26 + (ch.charCodeAt(0) - 64);
  }
  const digitRank = digits ? Number(digits) : 0;

  if (alpha) return alphaRank * 1000 + digitRank;
  if (digits) return Number(digits);
  return Number.POSITIVE_INFINITY;
}

function reorderRowsForTopSelection(rows, rowOrder) {
  if (rowOrder === "api") return rows.slice();

  const sorted = rows
    .slice()
    .sort((a, b) => {
      const diff = rowNameRank(a.rowName) - rowNameRank(b.rowName);
      if (diff !== 0) return diff;
      return String(a.rowName).localeCompare(String(b.rowName), undefined, {
        numeric: true,
        sensitivity: "base",
      });
    });

  if (rowOrder === "a_to_z_top_to_bottom") return sorted;
  if (rowOrder === "a_to_z_bottom_to_top") return sorted.reverse();
  return rows.slice();
}

function normalizeDataset(raw) {
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map((item, idx) => {
    const city = String(item?.city || "").trim();
    const movie = String(item?.movie || item?.movieName || "").trim();
    const language = String(item?.language || item?.lang || "").trim();
    const defaultRowOrder = normalizeRowOrder(item?.defaultRowOrder || item?.rowOrderDefault || "api");
    const theaterEntries = Array.isArray(item?.theaters)
      ? item.theaters
      : String(item?.theaters || item?.theater || "")
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
    const theaters = theaterEntries.map((t, tIdx) => {
      if (typeof t === "string") {
        const name = t.trim();
        if (!name) throw new Error(`Dataset item ${idx + 1}, theater ${tIdx + 1}: theater name is empty.`);
        return { name, rowOrder: defaultRowOrder };
      }
      const name = String(t?.name || t?.theater || "").trim();
      if (!name) throw new Error(`Dataset item ${idx + 1}, theater ${tIdx + 1}: theater.name is required.`);
      const rowOrder = normalizeRowOrder(t?.rowOrder || t?.row_order || defaultRowOrder);
      return { name, rowOrder };
    });
    const date = String(item?.date || "").trim();

    if (!city) throw new Error(`Dataset item ${idx + 1}: city is required.`);
    if (!movie) throw new Error(`Dataset item ${idx + 1}: movie is required.`);
    if (!language) throw new Error(`Dataset item ${idx + 1}: language is required.`);
    if (!theaters.length) throw new Error(`Dataset item ${idx + 1}: at least one theater is required.`);
    if (date && !isValidDate(date)) throw new Error(`Dataset item ${idx + 1}: invalid date (${date}).`);

    return {
      city,
      movie,
      language,
      theaters,
      defaultRowOrder,
      date: date || todayInIST(),
    };
  });
}

function buildTextReport(report) {
  const lines = [];
  lines.push("District Pre-7PM Top-2/3 Rows Report");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Rule: ${report.rule}`);
  lines.push(`Dataset items: ${report.datasetCount}`);
  lines.push(`Dropped dataset items (errors): ${report.droppedDatasetItems || 0}`);
  lines.push(`Dropped show records (seat-map errors): ${report.droppedShowErrors || 0}`);
  lines.push("");

  for (let i = 0; i < report.items.length; i++) {
    const item = report.items[i];
    const input = item.input || {};
    lines.push(`========== Item ${i + 1} ==========`);
    lines.push(`Input city: ${input.city || ""}`);
    lines.push(`Input movie: ${input.movie || ""}`);
    lines.push(`Input language: ${input.language || ""}`);
    lines.push(`Input date: ${input.date || ""}`);
    lines.push(
      `Input theaters: ${(input.theaters || [])
        .map((t) => `${t.name} [${t.rowOrder}]`)
        .join(", ")}`
    );

    lines.push(`Matches: ${item.matches.length}`);
    lines.push(`Dropped show records for this item: ${item.droppedShowErrors || 0}`);
    if (!item.matches.length) {
      lines.push("No matching shows before 7:00 PM IST.");
      lines.push("");
      continue;
    }

    for (let j = 0; j < item.matches.length; j++) {
      const m = item.matches[j];
      lines.push(`-- Match ${j + 1} --`);
      lines.push(`City: ${m.city}`);
      lines.push(`Movie: ${m.movie}`);
      lines.push(`Language: ${m.language}`);
      lines.push(`Theater: ${m.theater}`);
      lines.push(`Row order used: ${m.rowOrderUsed}`);
      lines.push(`Show: ${m.showTimeIST} (${m.showTimeHHMM})`);
      lines.push(`SessionId: ${m.sessionId}`);

      lines.push(`Rows total in layout: ${m.rowsTotalInLayout}`);
      lines.push(`Rows considered (top 2/3): ${m.rowsConsideredTopTwoThird}`);
      lines.push(`Rows with available seats: ${m.rowsWithAvailableSeats}`);

      if (!m.rowSeatDetails || !m.rowSeatDetails.length) {
        lines.push("No available seats in considered rows.");
        lines.push("");
        continue;
      }

      for (const row of m.rowSeatDetails) {
        lines.push(
          `Row ${row.row} [${row.area}] - ${row.availableSeatCount} seats: ${row.availableSeatNumbers.join(", ")}`
        );
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

async function processOneDataset(token, cities, item) {
  const city = cities.find((c) => includesInsensitive(c.name, item.city) || includesInsensitive(c.value, item.city));
  if (!city) {
    return {
      input: item,
      fatalError: `City not found: ${item.city}`,
      droppedShowErrors: 0,
      matches: [],
    };
  }

  const movies = await getMoviesByCity(token, city.value);
  const movieMatches = movies.filter(
    (m) =>
      includesInsensitive(m?.name, item.movie) &&
      (includesInsensitive(m?.lang, item.language) || includesInsensitive(m?.language, item.language))
  );
  if (!movieMatches.length) {
    return {
      input: item,
      fatalError: `Movie+language not found in city: ${item.movie} (${item.language})`,
      droppedShowErrors: 0,
      matches: [],
    };
  }

  const results = [];
  let droppedShowErrors = 0;

  for (const movie of movieMatches) {
    const sessionsJson = await getMovieSessions(token, {
      cityKey: city.value,
      movieCode: movie.frmtId,
      date: item.date,
      contentId: movie.contentId,
      latitude: city.lat,
      longitude: city.lon,
    });

    const sessionsByCinema = sessionsJson?.pageData?.sessions || {};
    const cinemas = sessionsJson?.meta?.cinemas || [];
    const cinemaMap = new Map(cinemas.map((c) => [String(c.id), c]));

    for (const [cinemaId, sessions] of Object.entries(sessionsByCinema)) {
      const theaterMeta = cinemaMap.get(String(cinemaId)) || {};
      const theaterName = theaterMeta?.name || theaterMeta?.label || `Cinema ${cinemaId}`;
      const theaterSelector = item.theaters.find(
        (wanted) =>
          includesInsensitive(theaterName, wanted?.name) ||
          includesInsensitive(wanted?.name, theaterName)
      );
      if (!theaterSelector) continue;

      for (const session of sessions || []) {
        const hhmm = showTimeISTHHMM(session.showTime);
        if (!hhmm || hhmm >= "19:00") continue;

        const payload = {
          cinemaId: Number(cinemaId),
          sessionId: String(session.sid),
          providerId: Number(session.pid),
          screenOnTop: true,
          freeSeating: Boolean(session.freeSeating || session.sType === 1),
          screenFormat: session.scrnFmt || "2D",
          moviecode: session.mid,
          config: { socialDistancing: 1 },
          contentId: String(movie.contentId || ""),
        };

        let seatJson;
        try {
          seatJson = await getSeatMap(token, payload);
        } catch (err) {
          droppedShowErrors += 1;
          continue;
        }

        if (seatJson?.error || seatJson?.status === "STATUS_FAILURE") {
          droppedShowErrors += 1;
          continue;
        }

        const allRows = extractRowsInDisplayOrder(seatJson);
        const rowOrderUsed = theaterSelector.rowOrder || item.defaultRowOrder || "api";
        const orderedRows = reorderRowsForTopSelection(allRows, rowOrderUsed);
        const consideredRows = topTwoThirdRows(orderedRows);
        const rowsWithSeats = consideredRows
          .filter((r) => r.availableSeatNumbers.length > 0)
          .map((r) => ({
            area: r.areaName,
            row: r.rowName,
            availableSeatCount: r.availableSeatNumbers.length,
            availableSeatNumbers: r.availableSeatNumbers,
          }));

        results.push({
          city: city.name,
          movie: movie.name,
          language: movie.lang || movie.language || "",
          theater: theaterName,
          rowOrderUsed,
          showTimeIST: formatShowTimeIST(session.showTime),
          showTimeHHMM: hhmm,
          sessionId: String(session.sid),
          rowsTotalInLayout: allRows.length,
          rowsConsideredTopTwoThird: consideredRows.length,
          rowsWithAvailableSeats: rowsWithSeats.length,
          rowSeatDetails: rowsWithSeats,
        });
      }
    }
  }

  return {
    input: item,
    fatalError: null,
    droppedShowErrors,
    matches: results,
  };
}

async function main() {
  // const datasetPath = process.argv[2];
  // if (!datasetPath) {
  //   console.error("Usage: ./district_dataset_pre7pm_rows_check.js <dataset.json>");
  //   process.exit(1);
  // }

  // const raw = await fs.readFile(datasetPath, "utf8");
  const raw = JSON.stringify([{
    "city": "Hyderabad",
    "movie": "Dhurandhar: The Revenge",
    "language": "Hindi",
    "defaultRowOrder": "api",
    "theaters": [
      {
        "name": "PVR Irrum Manzil, Khairatabad, Hyderabad",
        "rowOrder": "a_to_z_bottom_to_top"
      },
      {
        "name": "PVR Panjagutta, Central Mall, Hyderabad",
        "rowOrder": "a_to_z_bottom_to_top"
      },
      {
        "name": "Sudarshan 35MM 4K Laser & Dolby Atmos, RTC X Roads, Hyderabad",
        "rowOrder": "a_to_z_top_to_bottom"
      },
      {
        "name": "Miraj Cinemas : Shalini Shivani, Kothapet",
        "rowOrder": "a_to_z_top_to_bottom"
      },
      {
        "name": "Shiva Ganga Theatres 4K Gaddiannaram (Formerly Asian Shiva Ganga), Hyderabad",
        "rowOrder": "a_to_z_top_to_bottom"
      }
    ],
    "date": "2026-03-18"
  }]);
  const dataset = normalizeDataset(JSON.parse(raw));

  console.log("Fetching District guest token...");
  const token = await getGuestToken();
  console.log("Loading cities...");
  const cities = await getCities(token);

  const report = {
    generatedAt: new Date().toISOString(),
    rule: "Shows before 19:00 IST; seats only from top 2/3 rows with per-theater row order (api/a_to_z_top_to_bottom/a_to_z_bottom_to_top).",
    datasetCount: dataset.length,
    droppedDatasetItems: 0,
    droppedShowErrors: 0,
    items: [],
  };

  for (let i = 0; i < dataset.length; i++) {
    const item = dataset[i];
    console.log(`\n[${i + 1}/${dataset.length}] ${item.city} | ${item.movie} | ${item.language} | date ${item.date}`);
    const result = await processOneDataset(token, cities, item);
    report.droppedShowErrors += result.droppedShowErrors || 0;

    if (result.fatalError) {
      report.droppedDatasetItems += 1;
      console.log(`Dropped dataset item: ${result.fatalError}`);
      continue;
    }

    console.log(`Matches: ${result.matches.length} | dropped show errors: ${result.droppedShowErrors || 0}`);
    report.items.push({
      input: result.input,
      droppedShowErrors: result.droppedShowErrors || 0,
      matches: result.matches,
    });
  }

  const ts = Date.now();
  const outputJson = `district_pre7pm_top2by3_report_${ts}.json`;
  const outputTxt = `district_pre7pm_top2by3_report_${ts}.txt`;

  await fs.writeFile(outputJson, JSON.stringify(report, null, 2));
  await fs.writeFile(outputTxt, buildTextReport(report));

  console.log(`\nSaved JSON report: ${outputJson}`);
  console.log(`Saved text report: ${outputTxt}`);
}

main().catch((err) => {
  console.error(`\nError: ${err.message || err}`);
  process.exit(1);
});
