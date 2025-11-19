// app4.js

// Config - adjust only if you move files
const STOPS_GZ = 'https://eoinol.github.io/DBLive/stops.geojson.gz';
const WORKER_RT_URL = 'https://falling-firefly-fd90.eoinol.workers.dev/'; // returns { arrivals: [...] }
const R2_BUCKET_BASE = 'https://pub-aad94a89c9ea4f6390466b521c65d978.r2.dev/stops/';

// ----------------- utilities -----------------
function logDebug(...args){ console.debug('[app4]', ...args); const d = document.getElementById('debug'); if(d) d.textContent = args.map(a=> (typeof a==='object'?JSON.stringify(a):String(a))).join(' '); }

function degToCompass8(deg){
  const val = Math.floor((deg/45)+0.5);
  const pts = ["N","NE","E","SE","S","SW","W","NW"];
  return pts[val % 8];
}

function haversine(lat1,lon1,lat2,lon2){
  const R = 6371000;
  const toRad = v => v * Math.PI/180;
  const φ1 = toRad(lat1), φ2 = toRad(lat2);
  const dφ = toRad(lat2-lat1), dλ = toRad(lon2-lon1);
  const a = Math.sin(dφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(dλ/2)**2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  const dist = Math.round(R*c);
  const y = Math.sin(dλ)*Math.cos(φ2);
  const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(dλ);
  const bearingDeg = (Math.atan2(y,x)*180/Math.PI + 360) % 360;
  return { distance: dist, bearingDeg, bearing8: degToCompass8(bearingDeg) };
}

// safe JSON fetch helper
async function fetchJson(url){
  const r = await fetch(url);
  if(!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

// ----------------- load stops.geojson.gz -----------------
async function loadStops() {
  // fetch gzip blob
  const resp = await fetch(STOPS_GZ);
  if(!resp.ok) throw new Error('Failed to fetch stops.geojson.gz: ' + resp.status);
  const ab = await resp.arrayBuffer();
  // require pako to be available
  if(typeof pako === 'undefined') {
    console.error('pako not available. If your browser blocked CDN scripts, upload a local pako.min.js and reference it in index4.html.');
    throw new Error('pako not available');
  }
  const compressed = new Uint8Array(ab);
  const decompressed = pako.ungzip(compressed, { to: 'string' });
  // NOTE: some of your stops data historically started with "var stops = ...".
  // If that's the case, strip a leading var assignment.
  const trimmed = decompressed.trim();
  const possibleVar = trimmed.startsWith('var stops =') || trimmed.startsWith('const stops =') || trimmed.startsWith('let stops =');
  const jsonText = possibleVar ? trimmed.replace(/^[^{]*/, '').trim() : trimmed;
  return JSON.parse(jsonText);
}

// ----------------- load GTFS-RT (worker returns a minimal arrivals array) -----------------
async function loadRealtimeFromWorker(){
  const resp = await fetch(WORKER_RT_URL);
  if(!resp.ok) throw new Error(`GTFS-RT worker fetch failed: ${resp.status}`);
  const data = await resp.json();
  // Worker should return { arrivals: [ { trip_id, stop_id, delaySeconds, arrivalTimestamp, vehicleId? }, ... ] }
  if(!data || !Array.isArray(data.arrivals)) {
    console.warn('GTFS-RT worker returned unexpected shape', data);
    // try to normalise a few common variants:
    if(Array.isArray(data)) {
      return data;
    }
    throw new Error('GTFS-RT feed missing "arrivals" array');
  }
  return data.arrivals;
}

// Build a map: stop_id -> Set(trip_id) using GTFS-RT arrivals
function buildRtStopMap(arrivals){
  const map = new Map();
  for(const rec of arrivals){
    // Accept multiple shapes: prefer rec.trip_id, otherwise rec.trip?.trip_id, rec.trip_update.trip.trip_id etc.
    const trip_id = rec.trip_id || (rec.trip && rec.trip.trip_id) || (rec.trip_update && rec.trip_update.trip && rec.trip_update.trip.trip_id) || null;
    const stop_id = rec.stop_id || rec.stop_id || (rec.stop_time_update && rec.stop_time_update.stop_id) || (rec.stop && rec.stop.stop_id) || rec.stop_id;
    if(!trip_id || !stop_id) continue;
    if(!map.has(stop_id)) map.set(stop_id, new Set());
    map.get(stop_id).add(trip_id);
  }
  return map;
}

// ----------------- fetch stop JSON (R2) and build trip index -----------------
async function loadStopJsonIndex(atco){
  const url = `${R2_BUCKET_BASE}${atco}.json`;
  try {
    const resp = await fetch(url);
    if(!resp.ok) {
      // 404 or blocked by CORS - caller should handle gracefully
      throw new Error(`HTTP ${resp.status}`);
    }
    const arr = await resp.json(); // this is an array of scheduled rows for the stop
    // build map trip_id -> first row
    const tripIndex = new Map();
    for(const row of arr){
      if(!row.trip_id) continue;
      if(!tripIndex.has(row.trip_id)) tripIndex.set(row.trip_id, row);
    }
    return { ok: true, tripIndex };
  } catch (err) {
    console.warn('Error fetching stop JSON', atco, err);
    return { ok: false, error: err.message || String(err) };
  }
}

// ----------------- Rendering -----------------
async function renderStops(){
  const status = document.getElementById('status');
  try {
    status.textContent = 'Loading stops…';
    const stopsGeo = await loadStops();
    status.textContent = 'Getting location…';
    // get position
    const coords = await new Promise((res, rej) => {
      navigator.geolocation.getCurrentPosition(p => res(p.coords), e => rej(e));
    });

    status.textContent = `Location: ${coords.latitude.toFixed(6)}, ${coords.longitude.toFixed(6)} (±${coords.accuracy ? Math.round(coords.accuracy) + ' m' : '?)' })`;

    // annotate distances
    const annotated = stopsGeo.features.map(f => {
      const lat = parseFloat(f.properties.Latitude);
      const lon = parseFloat(f.properties.Longitude);
      const {distance, bearingDeg, bearing8} = haversine(coords.latitude, coords.longitude, lat, lon);
      return { feature: f, distance, bearingDeg, bearing8, lat, lon };
    });

    // nearest 5 stops
    annotated.sort((a,b) => a.distance - b.distance);
    const nearest = annotated.slice(0,5);

    status.textContent = 'Fetching GTFS-RT…';
    const rtArrivals = await loadRealtimeFromWorker();
    const rtMap = buildRtStopMap(rtArrivals);
    logDebug('Total GTFS-RT arrivals>', rtArrivals.length, 'distinct stops in RT:', rtMap.size);

    const container = document.getElementById('stops');
    container.innerHTML = '';

    for(const s of nearest){
      const f = s.feature;
      const atco = f.properties.AtcoCode;
      const stopNumber = parseInt(atco.slice(-6), 10);
      const mapsLink = `https://www.google.com/maps/search/?api=1&query=${s.lat},${s.lon}`;

      const stopDiv = document.createElement('div');
      stopDiv.className = 'stop';
      const header = document.createElement('h3');

      const titleSpan = document.createElement('span');
      titleSpan.textContent = `${f.properties.SCN_English} (#${stopNumber})`;
      header.appendChild(titleSpan);

      const metaSpan = document.createElement('span');
      metaSpan.className = 'meta';
      metaSpan.style.marginLeft = '8px';
      metaSpan.textContent = `${s.distance} m • ${s.bearing8}`;
      header.appendChild(metaSpan);

      const mapA = document.createElement('a');
      mapA.className = 'maplink';
      mapA.href = mapsLink;
      mapA.target = '_blank';
      mapA.rel = 'noopener';
      mapA.textContent = '[Map]';
      header.appendChild(mapA);

      stopDiv.appendChild(header);

      // get set of RT trip_ids for this stop
      const rtTripSet = rtMap.get(atco) || new Set();

      // if no RT trips for this stop -> show message
      if(rtTripSet.size === 0){
        const no = document.createElement('div');
        no.className = 'sub small';
        no.textContent = 'No real-time trips available';
        stopDiv.appendChild(no);
        container.appendChild(stopDiv);
        continue;
      }

      // load R2 JSON for this stop to find route/headsign/schedule mappings
      const idxResult = await loadStopJsonIndex(atco);
      const arrivalsUl = document.createElement('ul');
      arrivalsUl.className = 'arrivals';

      // For each trip_id present in RT: find its scheduled row
      for(const tripId of Array.from(rtTripSet)){
        let sched = null;
        if(idxResult.ok) sched = idxResult.tripIndex.get(tripId) || null;
        const li = document.createElement('li');

        // route/headsign from R2 if present, else show tripId
        const route = sched && sched.route_short ? sched.route_short : null;
        const headsign = sched && sched.trip_headsign ? sched.trip_headsign : null;
        const schedTime = sched && sched.arrival_time ? sched.arrival_time : null;

        // get RT matching entry for extra fields (if worker included arrivalTimestamp or delay)
        const rtMatch = rtArrivals.find(r => {
          const t = r.trip_id || (r.trip && r.trip.trip_id);
          const s = r.stop_id || r.stop;
          return t === tripId && (s === atco || String(s) === String(atco));
        });

        let text = '';
        if(route) text += `${route} → ${headsign || 'Unknown'}`;
        else text += `${tripId} → ${headsign || 'Unknown'}`;

        // scheduled time (if available)
        if(schedTime) text += ` | Scheduled: ${schedTime}`;

        // RT time or delay
        if(rtMatch){
          // prefer an explicit arrival timestamp (ISO), else compute from scheduled + delay
          if(rtMatch.arrivalTimestamp){
            try {
              const d = new Date(rtMatch.arrivalTimestamp);
              text += ` | Real-time: ${d.toLocaleTimeString()}`;
            } catch {}
          } else if(rtMatch.delaySeconds != null && schedTime){
            // add delay to scheduled time
            const [hh,mm,ss] = schedTime.split(':').map(x=>parseInt(x,10));
            if(!isNaN(hh)){
              const scheduledDate = new Date();
              scheduledDate.setHours(hh, mm || 0, ss || 0, 0);
              scheduledDate.setSeconds(scheduledDate.getSeconds() + Number(rtMatch.delaySeconds));
              text += ` | Real-time: ${scheduledDate.toLocaleTimeString()}`;
            } else {
              if(rtMatch.delaySeconds!=null) text += ` | Delay: ${rtMatch.delaySeconds}s`;
            }
          } else if(rtMatch.delaySeconds!=null){
            text += ` | Delay: ${rtMatch.delaySeconds}s`;
          }
        }

        li.textContent = text;
        arrivalsUl.appendChild(li);
      }

      stopDiv.appendChild(arrivalsUl);
      container.appendChild(stopDiv);
    }

    status.textContent = `Showing nearest stops (RT-driven). Last refresh: ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    console.error('Error rendering stops:', err);
    const status = document.getElementById('status');
    if(status) status.textContent = 'Error: ' + err.message;
    logDebug('Error:', err);
  }
}

// Init on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  renderStops();
});
