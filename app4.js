// Convert degrees to 8-point compass
function degToCompass(deg) {
  const val = Math.floor((deg / 45) + 0.5);
  const compassPoints = ["N","NE","E","SE","S","SW","W","NW"];
  return compassPoints[val % 8];
}

// Haversine distance + bearing
function getDistanceAndBearing(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  const distance = R * c;

  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ);
  const bearingDeg = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;

  return {distance: Math.round(distance), bearing: degToCompass(bearingDeg)};
}

// Load stops.geojson.gz
async function loadStops() {
  const resp = await fetch('stops.geojson.gz');
  const compressed = new Uint8Array(await resp.arrayBuffer());
  const decompressed = pako.ungzip(compressed, { to: 'string' });
  return JSON.parse(decompressed);
}

// Load individual stop JSON
async function loadStopJson(atco) {
  const url = `https://pub-aad94a89c9ea4f6390466b521c65d978.r2.dev/stops/${atco}.json`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return await resp.json();
  } catch (err) {
    console.warn(`Stop ${atco} failed`, err);
    return null;
  }
}

// Fetch full GTFS-RT feed from worker
async function loadRealtimeTrips() {
  const resp = await fetch('https://falling-firefly-fd90.eoinol.workers.dev/');
  if (!resp.ok) throw new Error(`GTFS-RT fetch failed: ${resp.status}`);
  const data = await resp.json();
  return data.entity || [];
}

// Merge scheduled stop arrivals with GTFS-RT
function mergeArrivals(stopArrivals, realtimeTrips) {
  const merged = [];

  stopArrivals.forEach(sa => {
    const tripRT = realtimeTrips
      .filter(e => e.trip_update && e.trip_update.stop_time_update)
      .map(e => {
        const stu = e.trip_update.stop_time_update.find(u => u.stop_id === sa.trip_id);
        if (!stu) return null;
        return {
          trip_id: e.trip_update.trip.trip_id,
          line: e.trip_update.trip.route_id,
          destination: e.trip_update.trip.headsign || sa.trip_headsign,
          realtime: stu.arrival?.time ? new Date(stu.arrival.time * 1000) : null,
          scheduled: sa.arrival_time ? new Date(`1970-01-01T${sa.arrival_time}`) : null
        };
      })
      .filter(x => x !== null);

    if (tripRT.length) merged.push(...tripRT);
    else merged.push({
      trip_id: sa.trip_id,
      line: sa.route_short,
      destination: sa.trip_headsign,
      realtime: null,
      scheduled: sa.arrival_time ? new Date(`1970-01-01T${sa.arrival_time}`) : null
    });
  });

  // Deduplicate by trip_id
  const unique = [];
  const seen = new Set();
  merged.forEach(a => {
    if (!seen.has(a.trip_id)) {
      unique.push(a);
      seen.add(a.trip_id);
    }
  });

  return unique.sort((a,b) => {
    if (!a.realtime && !b.realtime) return a.scheduled - b.scheduled;
    if (!a.realtime) return 1;
    if (!b.realtime) return -1;
    return a.realtime - b.realtime;
  });
}

// Main render
async function renderStops() {
  const stopsData = await loadStops();
  const userLoc = await new Promise((res, rej) => {
    navigator.geolocation.getCurrentPosition(p => res(p.coords), rej);
  });

  const stopsWithDistance = stopsData.features.map(f => {
    const {distance, bearing} = getDistanceAndBearing(
      userLoc.latitude, userLoc.longitude,
      parseFloat(f.properties.Latitude), parseFloat(f.properties.Longitude)
    );
    return {...f, distance, bearing};
  });

  const nearestStops = stopsWithDistance.sort((a,b) => a.distance-b.distance).slice(0,5);
  const realtimeTrips = await loadRealtimeTrips();

  const container = document.getElementById('stops');
  container.innerHTML = '';

  for (const stop of nearestStops) {
    const arrivals = await loadStopJson(stop.properties.AtcoCode);
    const merged = arrivals ? mergeArrivals(arrivals, realtimeTrips) : [];

    const stopNumber = parseInt(stop.properties.AtcoCode.slice(-6), 10);
    const mapsLink = `https://www.google.com/maps/search/?api=1&query=${stop.properties.Latitude},${stop.properties.Longitude}`;

    const stopDiv = document.createElement('div');
    stopDiv.className = 'stop';

    const stopHeader = document.createElement('h3');
    stopHeader.textContent = `${stop.properties.SCN_English} (#${stopNumber})`;

    const distanceEl = document.createElement('a');
    distanceEl.href = mapsLink;
    distanceEl.target = '_blank';
    distanceEl.textContent = `${stop.distance} m`;

    const bearingEl = document.createElement('span');
    bearingEl.textContent = ` • ${stop.bearing}`;

    stopDiv.appendChild(stopHeader);
    stopDiv.appendChild(distanceEl);
    stopDiv.appendChild(bearingEl);

    const arrivalsUl = document.createElement('ul');
    merged.forEach(a => {
      const li = document.createElement('li');
      li.textContent = `${a.line} → ${a.destination}`;
      if (a.realtime || a.scheduled) {
        li.textContent += ` | Real-time: ${a.realtime ? a.realtime.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : '--'} | Scheduled: ${a.scheduled ? a.scheduled.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : '--'}`;
      }
      arrivalsUl.appendChild(li);
    });

    stopDiv.appendChild(arrivalsUl);
    container.appendChild(stopDiv);
  }
}

document.addEventListener('DOMContentLoaded', renderStops);
