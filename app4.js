// app4.js — merge GTFS-RT trip updates with local schedule JSON per-stop files
// Requirements: pako.min.js in same folder, stops.geojson.gz in same folder.
// Cloudflare worker (GTFS-RT proxy) URL:
const WORKER_RT_URL = 'https://falling-firefly-fd90.eoinol.workers.dev/';

// R2 bucket base URL for stop JSONs (your public dev domain)
const STOP_JSON_BASE = 'https://pub-aad94a89c9ea4f6390466b521c65d978.r2.dev/stops/';

const MAX_NEARBY = 5;
const WINDOW_PAST_MIN = 30;
const WINDOW_FUTURE_MIN = 60;

// ---------- utilities ----------
function degToCompass(deg){
  const points = ['N','NE','E','SE','S','SW','W','NW'];
  return points[Math.round(((deg % 360) / 45)) % 8];
}
function haversine(lat1, lon1, lat2, lon2){
  const R = 6371000;
  const toRad = v => v * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  const dist = Math.round(R * c);
  const y = Math.sin(toRad(lon2-lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1))*Math.sin(toRad(lat2)) - Math.sin(toRad(lat1))*Math.cos(toRad(lat2))*Math.cos(toRad(lon2-lon1));
  const bearingDeg = (Math.atan2(y,x)*180/Math.PI + 360) % 360;
  return {dist, bearingDeg};
}
function pad2(n){ return n.toString().padStart(2,'0'); }
function timePartsToDate(dateYYYYMMDD, hhmmss){
  // dateYYYYMMDD like "20251119" or null -> use today
  let d;
  if (dateYYYYMMDD && /^\d{8}$/.test(dateYYYYMMDD)){
    const y = +dateYYYYMMDD.slice(0,4);
    const m = +dateYYYYMMDD.slice(4,6) - 1;
    const day = +dateYYYYMMDD.slice(6,8);
    d = new Date(Date.UTC(y,m,day,0,0,0)); // use UTC anchor to avoid TZ-shift
  } else {
    const now = new Date();
    d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(),0,0,0));
  }
  const parts = hhmmss.split(':').map(x => parseInt(x,10) || 0);
  // place hh/mm/ss onto that UTC-base date
  d.setUTCHours(parts[0], parts[1], parts[2]||0, 0);
  return d;
}
function formatTimeFromDate(d){
  // show local time (user) for readability
  return d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'});
}
function secondsToSignedString(sec){
  if (sec === 0) return '(on time)';
  const s = Math.abs(Math.round(sec));
  const sign = sec > 0 ? '+' : '-';
  return `${sign}${s}s`;
}

// ---------- data loaders ----------
async function loadStopsGeojsonGz(){
  const resp = await fetch('stops.geojson.gz');
  if (!resp.ok) throw new Error('stops.geojson.gz fetch failed: ' + resp.status);
  const buf = new Uint8Array(await resp.arrayBuffer());
  const text = pako.ungzip(buf, {to: 'string'});
  // file might start with "var stops = " — tolerate that
  const cleaned = text.trim().replace(/^\s*var\s+stops\s*=\s*/i, '');
  const json = JSON.parse(cleaned);
  return json;
}

async function loadGTFSRTFromWorker(){
  try {
    const resp = await fetch(WORKER_RT_URL);
    if (!resp.ok) {
      console.warn('GTFS-RT worker returned', resp.status, resp.statusText);
      return null;
    }
    // worker should return JSON (we made it return decoded TripUpdates earlier)
    const txt = await resp.text();
    if (txt.trim().startsWith('<')) {
      console.warn('GTFS-RT worker returned HTML (Cloudflare outage or error)');
      return null;
    }
    const obj = JSON.parse(txt);
    // support multiple shapes: obj.entity, obj.trip_updates, obj.arrivals, etc.
    if (obj.entity) return obj.entity;
    if (obj.trip_updates) return obj.trip_updates;
    if (obj.arrivals) return obj.arrivals;
    // maybe the worker already returned a top-level array
    if (Array.isArray(obj)) return obj;
    // otherwise, try to find trip_update-like entries:
    for (const k in obj) {
      if (Array.isArray(obj[k])) return obj[k];
    }
    return null;
  } catch (e) {
    console.error('GTFS-RT fetch/parsing error', e);
    return null;
  }
}

async function loadStopJsonR2(atcoCode){
  if (!atcoCode) return null;
  const url = STOP_JSON_BASE + encodeURIComponent(atcoCode) + '.json';
  try {
    const r = await fetch(url);
    if (!r.ok) {
      // 404 is common for unused stops — return null
      // console.debug('stop json not found', atcoCode, r.status);
      return null;
    }
    return await r.json();
  } catch (e) {
    console.warn('Error fetching stop json', atcoCode, e);
    return null;
  }
}

// ---------- build realtime lookup ----------
function buildRtLookup(entities){
  // Build: rtByTrip[trip_id] = { start_date, trip_headsign, route_id, vehicle_id, timestamp, stops: {stop_id or seq -> {arrival_time_unix, delay}}}
  const rtByTrip = Object.create(null);
  if (!entities) return rtByTrip;
  for (const ent of entities){
    // worker may return different shapes: ent.trip_update or ent.trip_update.trip etc.
    const tu = ent.trip_update || ent.tripUpdate || ent.trip_update || ent.tripUpdate || null;
    const top = ent.trip_update || ent.tripUpdate || ent.trip_update || ent.tripUpdate || null;
    // some workers used ent.trip_update inside ent — check both
    let tripBlock = null;
    if (ent.trip_update) tripBlock = ent.trip_update;
    else if (ent.tripUpdate) tripBlock = ent.tripUpdate;
    else if (ent.trip_update_raw) tripBlock = ent.trip_update_raw;
    else if (ent.trip_update && ent.trip_update.trip) tripBlock = ent.trip_update;
    else {
      // maybe this entity is the trip object itself (older worker)
      if (ent.trip && ent.stop_time_update) tripBlock = ent;
    }
    if (!tripBlock) {
      // fallback: if ent.trip exists
      if (ent.trip) tripBlock = ent;
      else continue;
    }

    const trip = tripBlock.trip || tripBlock;
    const trip_id = (trip.trip_id || trip.tripId || trip.trip_id || '').toString();
    if (!trip_id) continue;

    const start_date = trip.start_date || trip.startDate || null;
    const route_id = trip.route_id || trip.routeId || null;
    const trip_headsign = trip.trip_headsign || trip.tripHeadsign || trip.headsign || null;
    const vehicle = (tripBlock.vehicle && (tripBlock.vehicle.id || tripBlock.vehicle.vehicle || tripBlock.vehicle)) || (ent.vehicle && (ent.vehicle.id || ent.vehicle.vehicle)) || null;
    const timestamp = tripBlock.timestamp || tripBlock.ts || ent.timestamp || null;

    const stopMap = Object.create(null);
    const stu = tripBlock.stop_time_update || tripBlock.stopTimeUpdate || tripBlock.stop_time_updates || tripBlock.stop_time_update || tripBlock.stop_time_updates || tripBlock.stop_time_update;
    if (Array.isArray(stu)) {
      for (const s of stu){
        const seq = s.stop_sequence || s.stopSequence || s.stop_sequence;
        const stop_id = s.stop_id || s.stopId || s.stopId || s.stop_id;
        const arrival = s.arrival || s.arrival_time || s.arrivalTime || null;
        const departure = s.departure || s.departure_time || s.departureTime || null;
        // arrival may have .time (epoch seconds) or .delay (seconds)
        let arrivalUnix = null, delay = null;
        if (arrival) {
          if (arrival.time) arrivalUnix = Number(arrival.time) * 1000;
          if (arrival.delay !== undefined && arrival.delay !== null) delay = Number(arrival.delay);
        }
        if (departure) {
          if (departure.time && !arrivalUnix) arrivalUnix = Number(departure.time) * 1000;
          if (departure.delay !== undefined && departure.delay !== null && delay===null) delay = Number(departure.delay);
        }
        const key = stop_id || seq;
        if (key) stopMap[key] = { arrivalUnix, delay, seq, stop_id };
      }
    }
    rtByTrip[trip_id] = {
      start_date, route_id, trip_headsign, vehicle, timestamp, stops: stopMap
    };
  }
  return rtByTrip;
}

// ---------- merge logic ----------
function mergeScheduledWithRT(scheduleRows, rtByTrip){
  // scheduleRows: array of objects (trip_id, arrival_time [HH:MM:SS], route_short, trip_headsign, stop_sequence?, stop_id?, maybe service_id)
  // return rows annotated with realtime info where available
  const now = Date.now();
  const startWindow = now - WINDOW_PAST_MIN*60*1000;
  const endWindow = now + WINDOW_FUTURE_MIN*60*1000;

  const out = [];

  for (const r of scheduleRows){
    const trip_id = r.trip_id;
    const scheduledStr = r.arrival_time || r.time || r.departure_time || '';
    if (!scheduledStr) continue;
    // prefer RT trip start_date if available; else unknown
    const rt = trip_id && rtByTrip[trip_id] ? rtByTrip[trip_id] : null;
    let merged = { ...r, realtime: null, day: null, rt_found: false };

    if (rt){
      // find RT stop by exact stop_id first, else by stop_sequence
      const stopKey = r.stop_id || r.StopId || r.stop || null;
      let rtStop = null;
      if (stopKey && rt.stops[stopKey]) rtStop = rt.stops[stopKey];
      // try sequence if not found
      if (!rtStop && (r.stop_sequence || r.stop_seq || r.seq)) {
        const seqKey = r.stop_sequence || r.stop_seq || r.seq;
        if (rt.stops[seqKey]) rtStop = rt.stops[seqKey];
      }
      // fallback: maybe stop ids in RT have different formatting (strip leading zeros?)—we won't attempt complex heuristics now.
      if (rtStop){
        merged.rt_found = true;
        // If RT gives absolute epoch arrival time, use that
        if (rtStop.arrivalUnix) {
          merged.realtime = new Date(rtStop.arrivalUnix);
          // day from RT trip start_date if present, else infer from realtime
          merged.day = rt.start_date || merged.realtime.toISOString().slice(0,10).replace(/-/g,'');
          merged.delay_seconds = rtStop.delay !== undefined && rtStop.delay !== null ? rtStop.delay : Math.round((merged.realtime.getTime() - timePartsToDate(rt.start_date, scheduledStr).getTime())/1000);
        } else if (rtStop.delay !== undefined && rtStop.delay !== null) {
          // compute from scheduled using RT trip start_date if present
          const baseDate = timePartsToDate(rt.start_date, scheduledStr); // UTC anchored
          merged.realtime = new Date(baseDate.getTime() + rtStop.delay*1000);
          merged.day = rt.start_date || baseDate.toISOString().slice(0,10).replace(/-/g,'');
          merged.delay_seconds = rtStop.delay;
        } else {
          // no arrival info; mark found but no times
          merged.realtime = null;
          merged.day = rt.start_date || null;
          merged.delay_seconds = null;
        }
      } else {
        // RT has the trip but not a matching stop entry — still record top-level trip info
        merged.rt_found = true;
        merged.day = rt.start_date || null;
      }
      merged.rt_meta = { route_id: rt.route_id, trip_headsign: rt.trip_headsign, vehicle: rt.vehicle };
    } else {
      // no RT for this trip - day unknown (unless schedule has service info)
      merged.day = r.service_id || null;
    }

    // compute scheduled Date (for filtering) using rt.start_date if present else today
    const scheduledDate = timePartsToDate( (rt && rt.start_date) || null, scheduledStr );
    merged.scheduledDate = scheduledDate;
    // determine whether this arrival is within our ± window (use realtime if present else scheduled)
    const ref = merged.realtime ? merged.realtime.getTime() : scheduledDate.getTime();
    merged.withinWindow = (ref >= startWindow && ref <= endWindow);

    // add
    out.push(merged);
  }

  // keep only those in time window
  const filtered = out.filter(x => x.withinWindow);
  // dedupe by trip_id + arrival_time string
  const uniq = [];
  const seen = new Set();
  for (const item of filtered) {
    const key = `${item.trip_id}|${item.arrival_time}|${item.realtime ? item.realtime.getTime() : 'ns'}`;
    if (!seen.has(key)) { seen.add(key); uniq.push(item); }
  }
  // sort by effective time (realtime if present else scheduled)
  uniq.sort((a,b) => {
    const ta = a.realtime ? a.realtime.getTime() : a.scheduledDate.getTime();
    const tb = b.realtime ? b.realtime.getTime() : b.scheduledDate.getTime();
    return ta - tb;
  });

  return uniq;
}

// ---------- render ----------
async function render(){
  const statusEl = document.getElementById('status');
  statusEl.textContent = 'Loading stops…';
  let stopsGeo;
  try {
    stopsGeo = await loadStopsGeojsonGz();
  } catch (e) {
    console.error('Cannot load stops geojson', e);
    statusEl.textContent = 'Error loading stops.geojson.gz';
    return;
  }

  statusEl.textContent = 'Getting location…';
  let pos;
  try {
    pos = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy:true, timeout:10000, maximumAge:0 }));
  } catch (e) {
    console.error('Geolocation failed', e);
    statusEl.textContent = 'Cannot determine location (allow location and reload)';
    return;
  }

  statusEl.textContent = 'Finding nearest stops…';
  const locLat = pos.coords.latitude, locLon = pos.coords.longitude;
  // build list with distance
  const list = stopsGeo.features.map(f => {
    const lat = parseFloat(f.properties.Latitude), lon = parseFloat(f.properties.Longitude);
    if (isNaN(lat) || isNaN(lon)) return null;
    const {dist, bearingDeg} = (function(){ const r = haversine(locLat, locLon, lat, lon); return {dist: r.dist, bearingDeg: r.bearingDeg}; })();
    return { feature: f, dist, bearing: degToCompass(bearingDeg) };
  }).filter(Boolean).sort((a,b) => a.dist - b.dist).slice(0, MAX_NEARBY);

  statusEl.textContent = 'Loading RT feed…';
  const entities = await loadGTFSRTFromWorker();
  if (!entities) {
    statusEl.textContent = 'Realtime feed not available (worker offline). Showing scheduled times only.';
  } else {
    statusEl.textContent = 'Merging realtime with schedule…';
  }

  const rtByTrip = buildRtLookup(entities);

  const container = document.getElementById('stops');
  container.innerHTML = '';

  for (const entry of list){
    const f = entry.feature;
    const atco = f.properties.AtcoCode;
    const stopName = f.properties.SCN_English || f.properties.StopName || 'Unknown';
    const stopLat = parseFloat(f.properties.Latitude), stopLon = parseFloat(f.properties.Longitude);

    // load schedule JSON for this stop (precomputed files)
    const rawSchedule = await loadStopJsonR2(atco);
    // rawSchedule expected to be an array: [{trip_id, arrival_time, route_short, trip_headsign, stop_sequence, stop_id, service_id}, ...]
    const scheduleRows = Array.isArray(rawSchedule) ? rawSchedule : [];

    // merge
    const merged = mergeScheduledWithRT(scheduleRows, rtByTrip);

    // render
    const stopDiv = document.createElement('div');
    stopDiv.className = 'stop';

    const h3 = document.createElement('h3');
    h3.textContent = `${stopName} (#${(atco || '').slice(-6).replace(/^0+/, '')})`;
    stopDiv.appendChild(h3);

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML = `${entry.dist} m • ${entry.bearing} • <span class="small">RT available: ${entities ? 'yes' : 'no'}</span>`;
    stopDiv.appendChild(meta);

    const ul = document.createElement('ul');

    if (merged.length === 0) {
      const li = document.createElement('li');
      li.textContent = 'No upcoming arrivals in ± window.';
      ul.appendChild(li);
    } else {
      for (const m of merged){
        const li = document.createElement('li');

        const scheduled = m.arrival_time || m.time || '?';
        const schedDate = m.scheduledDate;
        const schedLocal = formatTimeFromDate(schedDate);
        let display = '';

        if (m.realtime){
          const rtLocal = formatTimeFromDate(m.realtime);
          const delay = m.delay_seconds !== undefined && m.delay_seconds !== null ? m.delay_seconds : Math.round((m.realtime.getTime() - schedDate.getTime())/1000);
          const delayStr = secondsToSignedString(delay);
          // show route, headsign, realtime and delay and trip id and date
          display = `${m.route_short || '?'} → ${m.trip_headsign || (m.rt_meta && m.rt_meta.trip_headsign) || '?'} at ${rtLocal} `;
          display += ` <span class="realtime">[RT]</span> <span class="small">(${delayStr})</span>`;
          display += ` <div class="small">scheduled ${schedLocal}</div>`;
          display += ` <div class="small">trip ${m.trip_id} date ${m.day || (m.rt_meta && m.rt_meta.start_date) || 'unknown'}</div>`;
        } else {
          // no realtime — show scheduled
          display = `${m.route_short || '?'} → ${m.trip_headsign || '?'} scheduled ${schedLocal} `;
          display += ` <div class="small">trip ${m.trip_id} date ${m.day || 'unknown'}</div>`;
        }

        li.innerHTML = display;
        ul.appendChild(li);
      }
    }

    stopDiv.appendChild(ul);
    container.appendChild(stopDiv);
  }

  statusEl.textContent = 'Done';
}

// Run on load
document.addEventListener('DOMContentLoaded', () => {
  render().catch(err => {
    console.error('Fatal rendering error', err);
    const s = document.getElementById('status');
    if (s) s.textContent = 'Fatal error: ' + err.message;
  });
});
