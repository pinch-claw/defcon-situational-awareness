import { RTC_CORRIDOR_DATA } from './rtc-corridor-data.js';

const LVCC = { name: 'LVCC West Hall', lat: 36.1314766, lon: -115.1512278 };
const SAHARA = { name: 'Sahara Las Vegas', lat: 36.1423481, lon: -115.1569128 };
const KLAS = { name: 'Harry Reid International Airport', lat: 36.0861034, lon: -115.1611002 };
const USER_AGENT = 'BlazeCon DEF CON situational awareness dashboard (public safety/travel display)';

const TRAFFIC_LAYERS = [
  { id: 'Incidents', label: 'NDOT incidents', severity: 'high' },
  { id: 'Closures', label: 'NDOT closures', severity: 'high' },
  { id: 'Construction', label: 'NDOT construction', severity: 'medium' },
  { id: 'SpecialEvents', label: 'NDOT special events', severity: 'medium' },
  { id: 'WazeIncidents', label: 'Waze incidents via Nevada 511', severity: 'medium' },
  { id: 'WazeClosures', label: 'Waze closures via Nevada 511', severity: 'high' },
];

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=45, s-maxage=120',
      'access-control-allow-origin': '*',
    },
  });
}

function milesBetween(a, b) {
  const R = 3958.8;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lon - a.lon) * Math.PI / 180;
  const lat1 = a.lat * Math.PI / 180;
  const lat2 = b.lat * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function filterNearCorridor(item, radiusMiles = 12) {
  const loc = Array.isArray(item.location) ? { lat: Number(item.location[0]), lon: Number(item.location[1]) } : null;
  if (!loc || Number.isNaN(loc.lat) || Number.isNaN(loc.lon)) return false;
  const distanceToLvcc = milesBetween(loc, LVCC);
  const distanceToSahara = milesBetween(loc, SAHARA);
  const distanceToAirport = milesBetween(loc, KLAS);
  const nearestDistanceMiles = Math.min(distanceToLvcc, distanceToSahara, distanceToAirport);
  item.nearestDistanceMiles = Number(nearestDistanceMiles.toFixed(1));
  return nearestDistanceMiles <= radiusMiles;
}

async function fetchJson(url, timeoutMs = 8500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'accept': 'application/json', 'user-agent': USER_AGENT },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, timeoutMs = 5500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'accept': 'text/html,application/xhtml+xml', 'user-agent': USER_AGENT },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchTrafficLayer(layer) {
  const url = `https://www.nvroads.com/map/mapIcons/${layer.id}`;
  const raw = await fetchJson(url);
  const all = Array.isArray(raw.item2) ? raw.item2 : [];
  const near = all.filter(filterNearCorridor).slice(0, 18);

  const enriched = await Promise.all(near.slice(0, 8).map(async (item) => {
    let summary = layer.label;
    try {
      const tooltip = await fetchText(`https://www.nvroads.com/tooltip/${layer.id}/${item.itemId}?lang=en`);
      const clean = stripHtml(tooltip);
      if (clean) summary = clean.slice(0, 260);
    } catch (_) {
      // Tooltips are best-effort; map icons still prove a live event exists.
    }
    return {
      id: `${layer.id}-${item.itemId}`,
      layer: layer.id,
      label: layer.label,
      severity: layer.severity,
      title: item.title || layer.label,
      summary,
      lat: item.location?.[0],
      lon: item.location?.[1],
      nearestDistanceMiles: item.nearestDistanceMiles,
      sourceUrl: 'https://www.nvroads.com/',
    };
  }));

  return { layer: layer.id, label: layer.label, totalStatewide: all.length, nearCorridor: near.length, items: enriched };
}

async function getWeather() {
  const [point, alerts, observation] = await Promise.all([
    fetchJson(`https://api.weather.gov/points/${LVCC.lat},${LVCC.lon}`),
    fetchJson(`https://api.weather.gov/alerts/active?point=${LVCC.lat},${LVCC.lon}`),
    fetchJson('https://api.weather.gov/stations/KLAS/observations/latest'),
  ]);

  let forecast = [];
  try {
    const forecastUrl = point?.properties?.forecastHourly || point?.properties?.forecast;
    if (forecastUrl) {
      const f = await fetchJson(forecastUrl);
      forecast = (f?.properties?.periods || []).slice(0, 8).map((p) => ({
        name: p.name,
        startTime: p.startTime,
        temperature: p.temperature,
        temperatureUnit: p.temperatureUnit,
        windSpeed: p.windSpeed,
        windDirection: p.windDirection,
        shortForecast: p.shortForecast,
      }));
    }
  } catch (_) {}

  const props = observation?.properties || {};
  const tempC = props.temperature?.value;
  const tempF = typeof tempC === 'number' ? Math.round((tempC * 9 / 5) + 32) : null;
  const windKph = props.windSpeed?.value;
  const windMph = typeof windKph === 'number' ? Math.round(windKph * 0.621371) : null;

  return {
    current: {
      station: 'KLAS',
      timestamp: props.timestamp,
      text: props.textDescription || 'Latest airport observation',
      temperatureF: tempF,
      windMph,
      windDirectionDegrees: props.windDirection?.value ?? null,
      rawMessage: props.rawMessage || null,
    },
    alerts: (alerts?.features || []).map((f) => ({
      id: f.id,
      event: f.properties?.event,
      severity: f.properties?.severity,
      headline: f.properties?.headline,
      instruction: f.properties?.instruction,
      effective: f.properties?.effective,
      expires: f.properties?.expires,
    })),
    forecast,
  };
}

async function getTraffic() {
  const results = await Promise.allSettled(TRAFFIC_LAYERS.map(fetchTrafficLayer));
  const layers = [];
  const errors = [];
  for (const r of results) {
    if (r.status === 'fulfilled') layers.push(r.value);
    else errors.push(String(r.reason?.message || r.reason));
  }
  const items = layers.flatMap((l) => l.items)
    .sort((a, b) => (a.nearestDistanceMiles ?? 999) - (b.nearestDistanceMiles ?? 999))
    .slice(0, 30);
  return {
    layers,
    items,
    counts: {
      statewide: layers.reduce((sum, l) => sum + l.totalStatewide, 0),
      nearCorridor: layers.reduce((sum, l) => sum + l.nearCorridor, 0),
      shown: items.length,
    },
    errors,
  };
}

function yyyymmddInVegas(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
  return `${parts.year}${parts.month}${parts.day}`;
}

function secondsSinceVegasMidnight(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(date).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
  const hour = Number(parts.hour === '24' ? '0' : parts.hour);
  return hour * 3600 + Number(parts.minute) * 60 + Number(parts.second);
}

function weekdayKeyInVegas(date = new Date()) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'long' }).format(date).toLowerCase();
}

function gtfsTimeToSeconds(time) {
  const [h, m, s] = String(time || '').trim().split(':').map(Number);
  if ([h, m, s].some(Number.isNaN)) return null;
  return h * 3600 + m * 60 + s;
}

function formatEta(minutes) {
  if (minutes <= 0) return 'due';
  if (minutes === 1) return '1 min';
  return `${minutes} min`;
}

function activeServiceIdsForVegasDate(date = new Date()) {
  const day = yyyymmddInVegas(date);
  const weekday = weekdayKeyInVegas(date);
  const active = new Set();
  for (const c of RTC_CORRIDOR_DATA.calendar) {
    if (c.start_date <= day && c.end_date >= day && c[weekday] === '1') active.add(c.service_id);
  }
  for (const ex of RTC_CORRIDOR_DATA.calendar_dates) {
    if (ex.date !== day) continue;
    if (ex.exception_type === '1') active.add(ex.service_id);
    if (ex.exception_type === '2') active.delete(ex.service_id);
  }
  return active;
}

function getScheduledTransit(now = new Date()) {
  const activeServices = activeServiceIdsForVegasDate(now);
  const nowSeconds = secondsSinceVegasMidnight(now);
  const trips = new Map(RTC_CORRIDOR_DATA.trips.map((t) => [t.trip_id, t]));
  const stops = new Map(RTC_CORRIDOR_DATA.stops.map((s) => [s.stop_id, s]));
  const upcoming = [];

  for (const st of RTC_CORRIDOR_DATA.stopTimes) {
    const trip = trips.get(st.trip_id);
    if (!trip || !activeServices.has(trip.service_id)) continue;
    const stopSeconds = gtfsTimeToSeconds(st.arrival_time);
    if (stopSeconds == null) continue;
    const delta = stopSeconds - nowSeconds;
    if (delta < -90 || delta > 4 * 3600) continue;
    const stop = stops.get(st.stop_id);
    const minutes = Math.max(0, Math.round(delta / 60));
    upcoming.push({
      route: trip.route_short_name,
      headsign: trip.headsign,
      stop: stop?.stop_name || st.stop_id,
      stopCode: stop?.stop_code || st.stop_id,
      anchor: stop?.anchor || 'corridor',
      etaMinutes: minutes,
      etaText: formatEta(minutes),
      scheduledTime: st.arrival_time,
      source: 'RTC static GTFS schedule',
    });
  }

  upcoming.sort((a, b) => a.etaMinutes - b.etaMinutes || a.route.localeCompare(b.route));
  return {
    mode: 'scheduled-static-gtfs',
    feedVersion: RTC_CORRIDOR_DATA.feed_info.feed_version,
    feedStartDate: RTC_CORRIDOR_DATA.feed_info.feed_start_date,
    feedEndDate: RTC_CORRIDOR_DATA.feed_info.feed_end_date,
    source: RTC_CORRIDOR_DATA.source,
    sourceNote: RTC_CORRIDOR_DATA.source_note,
    activeServiceCount: activeServices.size,
    stopCount: RTC_CORRIDOR_DATA.stops.length,
    upcoming: upcoming.slice(0, 14),
  };
}

function getTransit() {
  const schedule = getScheduledTransit();
  return {
    status: 'RTC GTFS-Realtime is Swiftly-gated, but the official static RTC schedule is embedded for corridor ETA planning. Use official trackers for actual live vehicle positions.',
    schedule,
    links: [
      { label: 'RTC Real-Time Ride Tracker', url: 'https://www.rtcsnv.com/' },
      { label: 'Official RTC GTFS static feed', url: 'https://developer.rtcsnv.com/transitData/google_transit.zip' },
      { label: 'Transitland RTC realtime metadata', url: 'https://transit.land/feeds/f-rtcsnv~rt' },
      { label: 'Las Vegas Monorail schedule/status', url: 'https://www.lvmonorail.com/' },
      { label: 'Google transit directions: Sahara → LVCC West', url: 'https://www.google.com/maps/dir/Sahara+Las+Vegas,+2535+S+Las+Vegas+Blvd,+Las+Vegas,+NV+89109/Las+Vegas+Convention+Center+West+Hall,+Las+Vegas,+NV' },
    ],
    nearbyStops: [
      { name: 'Sahara Monorail Station', lat: 36.1425082, lon: -115.1546065, mode: 'monorail' },
      { name: 'Boingo Station at LVCC', lat: 36.1322, lon: -115.1540, mode: 'monorail' },
      { name: 'Southbound Las Vegas after Sahara', lat: 36.1429244, lon: -115.1582, mode: 'bus' },
      { name: 'Paradise before Convention Center', lat: 36.1329099, lon: -115.155047, mode: 'bus' },
    ],
  };
}

export async function onRequestGet() {
  const started = Date.now();
  const sourceHealth = [];

  const [weatherRes, trafficRes] = await Promise.allSettled([getWeather(), getTraffic()]);
  const weather = weatherRes.status === 'fulfilled' ? weatherRes.value : { current: null, alerts: [], forecast: [], error: String(weatherRes.reason?.message || weatherRes.reason) };
  const traffic = trafficRes.status === 'fulfilled' ? trafficRes.value : { layers: [], items: [], counts: { statewide: 0, nearCorridor: 0, shown: 0 }, errors: [String(trafficRes.reason?.message || trafficRes.reason)] };

  sourceHealth.push({ name: 'National Weather Service API', url: 'https://api.weather.gov/', ok: weatherRes.status === 'fulfilled' });
  sourceHealth.push({ name: 'Nevada 511 map feed', url: 'https://www.nvroads.com/', ok: trafficRes.status === 'fulfilled' && !traffic.errors?.length });
  sourceHealth.push({ name: 'RTC static GTFS corridor schedule', url: 'https://developer.rtcsnv.com/transitData/google_transit.zip', ok: true, note: `embedded schedule ${RTC_CORRIDOR_DATA.feed_info.feed_version}` });
  sourceHealth.push({ name: 'RTC / Monorail live trackers', url: 'https://www.rtcsnv.com/', ok: true, note: 'linked; realtime feed requires Swiftly authorization' });

  return json({
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
    anchors: { lvcc: LVCC, sahara: SAHARA, airport: KLAS },
    weather,
    traffic,
    transit: getTransit(),
    sourceHealth,
  });
}
