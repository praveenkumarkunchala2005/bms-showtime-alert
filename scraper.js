#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { PlaywrightCrawler, RequestQueue, log as crawleeLog, LogLevel } from 'crawlee';

// ─── Stealth & Cloudflare Anti-Bot Bypass ─────────────────────────────────────
const stealthHook = async ({ page }) => {
    await page.context().addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        window.chrome = { runtime: {}, app: {}, client: {} };
    });
};

// ─── Dismiss BookMyShow Overlays ──────────────────────────────────────────────
async function dismissOverlays(page, log) {
    try {
        const clicked = await page.evaluate(() => {
            const proceedButtons = Array.from(document.querySelectorAll('button, a, div, span')).filter(el => {
                const text = el.innerText.trim().toUpperCase();
                return text === 'ACCEPT' || text === 'PROCEED' || text === 'OK' || text === 'I AGREE' || text === 'CONTINUE';
            });
            const visibleProceed = proceedButtons.find(b => b.offsetHeight > 0 && b.offsetWidth > 0);
            if (visibleProceed) {
                visibleProceed.click();
                return 'proceed';
            }

            const dialogs = Array.from(document.querySelectorAll('div[role="dialog"], [class*="modal"], [class*="popup"], [id*="modal"], [id*="popup"]'));
            for (const dialog of dialogs) {
                if (dialog.offsetHeight > 0 && dialog.offsetWidth > 0) {
                    const options = Array.from(dialog.querySelectorAll('li, button, .chip, a, [id*="language"], [id*="format"]')).filter(el => {
                        const text = el.innerText.trim();
                        return text.includes('2D') || text.includes('3D') || text.includes('IMAX') ||
                               ['HINDI', 'ENGLISH', 'MARATHI', 'GUJARATI', 'TELUGU', 'TAMIL'].some(lang => text.toUpperCase().includes(lang));
                    });
                    const visibleOption = options.find(o => o.offsetHeight > 0 && o.offsetWidth > 0);
                    if (visibleOption) {
                        visibleOption.click();
                        return 'language';
                    }
                }
            }

            const formatChips = Array.from(document.querySelectorAll('li, button, a, [class*="chip"], [class*="format"], [class*="lang"]')).filter(el => {
                const text = el.innerText.trim();
                return (text === '2D' || text === '3D' || text === 'IMAX 2D' || text === 'TELUGU' || text === 'HINDI' || text === 'ENGLISH') &&
                       el.offsetHeight > 0 && el.offsetWidth > 0 && el.children.length === 0;
            });
            if (formatChips.length > 0) {
                formatChips[0].click();
                return 'formatChip';
            }

            return null;
        });

        if (clicked) {
            log.info(`Handled overlay: clicked "${clicked}"`);
            await page.waitForTimeout(2000);
        }
    } catch (err) {
        log.warning(`Overlay handler skipped: ${err.message}`);
    }
}

// ─── Scrape All Showtimes ─────────────────────────────────────────────────────
export async function getAllShowSeats(city = 'hyderabad', movieSlug, movieId, date, theatreCode) {
    const formattedCity = city.toLowerCase();
    const cleanDate = date.replace(/-/g, '');
    const url = `https://in.bookmyshow.com/movies/${formattedCity}/${movieSlug}-${formattedCity}/buytickets/${movieId}/${cleanDate}`;

    let discoveredShows = [];
    let matchedTheatreName = '';

    console.log(`[getAllShowSeats] Discovering showtimes at theatre matching "${theatreCode}" on ${cleanDate}...`);

    const showtimeCrawler = new PlaywrightCrawler({
        maxRequestsPerCrawl: 1,
        launchContext: {
            launchOptions: {
                headless: true,
                args: [
                    '--disable-blink-features=AutomationControlled',
                    '--disable-web-security',
                    '--disable-site-isolation-trials',
                    '--no-sandbox',
                    '--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
                ]
            }
        },
        preNavigationHooks: [stealthHook],
        async requestHandler({ page, log }) {
            log.info(`Navigating to showtimes page: ${url}...`);
            await page.waitForLoadState('domcontentloaded');
            await dismissOverlays(page, log);
            await page.waitForTimeout(3000);

            for (let attempt = 0; attempt < 5; attempt++) {
                const data = await page.evaluate((tCode) => {
                    const cleanTarget = tCode.toLowerCase().replace(/[^a-z0-9]/g, '');
                    const parts = tCode.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim().split(/\s+/).filter(w => w.length >= 2);

                    const nameEl = Array.from(document.querySelectorAll('*')).find(el => {
                        if (el.children.length > 0) return false;
                        const txt = (el.innerText || '').trim().toLowerCase();
                        const cleanT = txt.replace(/[^a-z0-9]/g, '');
                        return cleanT.includes(cleanTarget) || (parts.length > 1 && parts.every(p => txt.includes(p))) || (txt.includes('art') && txt.includes('vanasthalipuram'));
                    });

                    if (!nameEl) return { theatreName: '', shows: [] };

                    let targetRow = nameEl.parentElement;
                    while (targetRow && targetRow !== document.body) {
                        const hasTimes = Array.from(targetRow.querySelectorAll('*')).some(c => /(?:1[0-2]|0?[1-9]):[0-5][0-9]\s*(?:AM|PM)/i.test(c.innerText || ''));
                        if (hasTimes) break;
                        targetRow = targetRow.parentElement;
                    }

                    if (!targetRow) return { theatreName: nameEl.innerText.trim(), shows: [] };
                    const tName = nameEl.innerText.trim();

                    const timeRegex = /(?:1[0-2]|0?[1-9]):[0-5][0-9]\s*(?:AM|PM)/i;
                    const showElements = Array.from(targetRow.querySelectorAll('a, button, div, span, li')).filter(el => {
                        if (el.offsetHeight === 0 || el.offsetWidth === 0) return false;
                        const text = (el.innerText || '').trim();
                        if (!timeRegex.test(text)) return false;

                        const childTimes = Array.from(el.querySelectorAll('*')).filter(c => c !== el && timeRegex.test((c.innerText || '').trim()));
                        return childTimes.length === 0;
                    });

                    const shows = [];
                    showElements.forEach(el => {
                        const text = el.innerText.trim();
                        const match = text.match(timeRegex);
                        if (match) {
                            const time = match[0].toUpperCase();
                            let status = 'Available';

                            const parent = el.closest('a, button, li, div') || el;
                            const style = window.getComputedStyle(parent);
                            const elStyle = window.getComputedStyle(el);
                            const className = (parent.className || '').toLowerCase() + ' ' + (el.className || '').toLowerCase();
                            const color = style.color || elStyle.color || '';
                            const opacity = parseFloat(style.opacity || elStyle.opacity || '1');
                            const isPointerDisabled = style.pointerEvents === 'none' || elStyle.pointerEvents === 'none';

                            // Explicit check for rgb(179, 179, 179) or gray disabled styling
                            const isGray = color.includes('179, 179, 179') ||
                                           color.includes('179,179,179') ||
                                           color.includes('153, 153, 153') ||
                                           color.includes('128, 128, 128') ||
                                           className.includes('disabled') ||
                                           className.includes('gray') ||
                                           className.includes('grey') ||
                                           className.includes('off') ||
                                           className.includes('past') ||
                                           opacity < 0.8 ||
                                           isPointerDisabled;

                            if (isGray) {
                                status = 'Disabled (Gray)';
                            } else if (className.includes('sold') || parent.innerText.includes('Sold')) {
                                status = 'Sold Out';
                            } else if (className.includes('filling') || parent.innerText.includes('Filling')) {
                                status = 'Filling Fast';
                            }

                            if (!shows.some(s => s.time === time)) {
                                shows.push({ time, status });
                            }
                        }
                    });

                    return { theatreName: tName, shows };
                }, theatreCode);

                if (data.shows && data.shows.length > 0) {
                    discoveredShows = data.shows;
                    matchedTheatreName = data.theatreName;
                    break;
                }
                await page.waitForTimeout(1000);
            }

            log.info(`Found ${discoveredShows.length} shows for theatre "${matchedTheatreName}"`);
        }
    });

    await showtimeCrawler.run([url]);

    if (discoveredShows.length === 0) {
        console.log(`[getAllShowSeats] No shows found for theatre matching "${theatreCode}" on ${cleanDate}`);
        return [];
    }

    const results = [];
    // Just check if showtime is gray colour or not.
    // If gray: isGray = true, available = false. If not gray: isGray = false, available = true.
    discoveredShows.forEach(show => {
        const isGray = show.status === 'Disabled (Gray)' || show.status.includes('Disabled') || show.status.includes('Gray');
        results.push({
            time: show.time,
            status: isGray ? 'Disabled (Gray)' : (show.status || 'Available'),
            isGray: isGray,
            available: !isGray,
            theatre: matchedTheatreName,
            theatreCode,
            totalSeats: 0,
            booked: 0,
            availableSeats: [],
            seats: []
        });
    });


    results.sort((a, b) => {
        const orderA = discoveredShows.findIndex(s => s.time === a.time);
        const orderB = discoveredShows.findIndex(s => s.time === b.time);
        return orderA - orderB;
    });

    return results;
}

// ─── CLI Output Formatter ────────────────────────────────────────────────────
function printTable(title, headers, rows) {
    console.log(`\n=== ${title.toUpperCase()} ===`);
    if (rows.length === 0) {
        console.log('No data available.');
        return;
    }
    const colWidths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i] || '').length)));
    const border = '+' + colWidths.map(w => '-'.repeat(w + 2)).join('+') + '+';
    console.log(border);
    console.log('| ' + headers.map((h, i) => h.padEnd(colWidths[i])).join(' | ') + ' |');
    console.log(border);
    rows.forEach(r => {
        console.log('| ' + r.map((cell, i) => String(cell || '').padEnd(colWidths[i])).join(' | ') + ' |');
    });
    console.log(border);
}

// ─── CLI Parameter & Config Parser ───────────────────────────────────────────
function parseArgs() {
    const args = process.argv.slice(2);
    const parsed = { isJson: false };
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--json') {
            parsed.isJson = true;
        } else if (args[i] === '--config' && args[i + 1]) {
            parsed.configPath = args[++i];
        } else if (args[i] === '--city' && args[i + 1]) {
            parsed.city = args[++i];
        } else if (args[i] === '--movieSlug' && args[i + 1]) {
            parsed.movieSlug = args[++i];
        } else if (args[i] === '--movieId' && args[i + 1]) {
            parsed.movieId = args[++i];
        } else if (args[i] === '--date' && args[i + 1]) {
            parsed.date = args[++i];
        } else if (args[i] === '--theatreCode' && args[i + 1]) {
            parsed.theatreCode = args[++i];
        }
    }
    return parsed;
}

// ─── Main Execution ───────────────────────────────────────────────────────────
async function runSpiderManScraper() {
    const cli = parseArgs();
    let cfg = {};

    if (cli.configPath) {
        try {
            const absPath = path.resolve(process.cwd(), cli.configPath);
            if (fs.existsSync(absPath)) {
                const raw = fs.readFileSync(absPath, 'utf8');
                cfg = JSON.parse(raw);
            }
        } catch (e) {
            if (!cli.isJson) {
                console.error(`Warning: Failed to load config from ${cli.configPath}: ${e.message}`);
            }
        }
    }

    // Resolve URL template if present
    let templateCity = '';
    let templateSlug = '';
    let templateId = '';
    if (cfg.url_template) {
        const match = cfg.url_template.match(/movies\/([^/]+)\/([^/]+)\/buytickets\/([^/]+)/);
        if (match) {
            templateCity = match[1];
            templateSlug = match[2];
            templateId = match[3];
        }
    }

    const city = cli.city || cfg.city || templateCity || 'hyderabad';
    const movieSlug = cli.movieSlug || cfg.movie_slug || templateSlug || 'spider-man-brand-new-day';
    const movieId = cli.movieId || cfg.movie_id || templateId || 'ET00505581';
    const theatreCode = cli.theatreCode || cfg.venue_label || cfg.theatre || cfg.venue_code || 'ART CINEMAS: Vanasthalipuram';
    
    const rawDate = cli.date || cfg.requested_date || '20260730';
    const dates = rawDate.includes(',') ? rawDate.split(',').map(d => d.trim()) : [rawDate.trim()];

    const isJson = cli.isJson;

    if (isJson) {
        crawleeLog.setLevel(LogLevel.OFF);
        // Redirect console log output to stderr so stdout receives strictly JSON
        console.log = function(...args) {
            console.error(...args);
        };
    }

    const output = {
        success: true,
        available: false,
        city,
        movieSlug,
        movieId,
        theatreCode,
        dates: dates,
        dateResults: []
    };

    if (!isJson) {
        process.stdout.write(`\n🎬 Scraping seat availability for ${movieSlug.toUpperCase()} (${movieId})\n`);
        process.stdout.write(`📍 Theatre: ${theatreCode} | City: ${city.toUpperCase()}\n`);
    }

    for (const date of dates) {
        if (!isJson) {
            process.stdout.write(`\n===============================================================\n`);
            process.stdout.write(`📅 DATE: ${date}\n`);
            process.stdout.write(`===============================================================\n`);
        }

        try {
            const showResults = await getAllShowSeats(city, movieSlug, movieId, date, theatreCode);

            const dateAvailable = showResults && showResults.some(s => !s.isGray && s.available);
            if (dateAvailable) {
                output.available = true;
            }

            output.dateResults.push({
                date,
                available: dateAvailable,
                showResults: showResults || []
            });

            if (!isJson) {
                if (!showResults || showResults.length === 0) {
                    process.stdout.write(`No showtimes found for ${date}.\n`);
                    continue;
                }

                const tableRows = showResults.map(r => [
                    r.time,
                    r.status,
                    r.isGray ? 'true (gray)' : 'false (not gray)',
                    r.available ? 'true' : 'false'
                ]);

                printTable(`ALL SHOWS OVERVIEW ON ${date}`, ['Showtime', 'Status', 'Is Gray', 'Is Available'], tableRows);

                showResults.forEach(s => {
                    process.stdout.write(`\n🎫 Showtime: ${s.time} | Gray: ${s.isGray} -> Status: ${s.available ? 'true (Not Gray)' : 'false (Gray)'}\n`);
                });
            }

        } catch (err) {
            output.dateResults.push({
                date,
                available: false,
                error: err.message,
                showResults: []
            });
            if (!isJson) {
                process.stderr.write(`Error scraping date ${date}: ${err.message}\n`);
            }
        }
    }

    if (!isJson) {
        process.stdout.write('\n✅ Scraping completed!\n\n');
    } else {
        process.stdout.write(JSON.stringify(output) + '\n');
    }
}

runSpiderManScraper().catch(err => {
    if (process.argv.includes('--json')) {
        process.stdout.write(JSON.stringify({
            success: false,
            available: false,
            error: err.message
        }) + '\n');
    } else {
        console.error(err);
    }
    process.exit(1);
});

