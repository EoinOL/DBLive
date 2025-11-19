// Convert degrees to 8-point compass
function degToCompass(deg) {
  const val = Math.floor((deg / 45) + 0.5);
  const compassPoints = ["N","NE","E","SE","S","SW","W","NW"];
  return compassPoints[val % 8];
}

// Calculate distance and bearing between two lat/lon points
function getDistanceAndBearing(lat1, lon1, lat2, lon2) {
  const R = 6371000; // meters
  const φ1 = lat1 * Math.PI/180;
  const φ2 = lat2 * Math.PI/180;
  const Δφ = (lat2-lat1)*Math.PI/180;
  const Δλ = (lon2-lon1)*Math.PI/180;

  const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  const distance = R * c;

  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ);
  const bearingDeg = (Math.atan2(y, x)*180/Math.PI + 360)%360;

  return {distance: Math.round(distance), bearing: degToCompass(bearingDeg)};
}

// Load stops.geojson.gz using pako
async function loadStops() {
  const resp = await fetch('stops.geojson.gz');
  const compressed = new Uint8Array(await resp.arrayBuffer());
  const decompressed = pako.ungzip(compressed, { to: 'string' });
  return JSON.parse(decompressed);
}

// Load GTFS scheduled data (JSON stop files)
async function loadStopJson(atcoCode) {
  try {
    const resp = await fetch(`stops/${atcoCode}.json`);
    if (!resp.ok) return null;
    return await resp.json();
  } catch(e) { return null; }
}

// Load GTFS-RT via Cloudflare worker
async function loadRealtimeTrips() {
  try {
    const resp = await fetch('https://falling-firefly-fd90.eoinol.workers.dev/');
    if (!resp.ok) throw new Error(`GTFS-RT fetch failed: ${resp.status}`);
    const data = await resp.json();
    // Map stop_id → array of RT updates
    const tripsByStop = {};
    data.entity.forEach(e => {
      if (!e.trip_update || !e.trip_update.stop_time_update) return;
      const trip = e.trip_update.trip;
      e.trip_update.stop_time_update.forEach(stu => {
        const stop = stu.stop_id;
        if (!tripsByStop[stop]) tripsByStop[stop] = [];
        tripsByStop[stop].push({
          trip_id: trip?.trip_id || "unknown",
          route_id: trip?.route_id || "Unknown",
          headsign: trip?.headsign || "Unknown",
          arrival_time: stu.arrival?.time ? new Date(stu.arrival.time*1000).toISOString() : null
        });
      });
    });
    return tripsByStop;
  } catch(err) {
    console.error("Failed to fetch GTFS-RT:", err);
    return {};
  }
}

// Main render
async function renderStops() {
  const stopsData = await loadStops();
  let userLoc;
  try {
    userLoc = await new Promise((res, rej) => 
      navigator.geolocation.getCurrentPosition(pos => res(pos.coords), err => rej(err))
    );
  } catch(e) {
    console.warn("Location unavailable, defaulting to 0,0");
    userLoc = { latitude:0, longitude:0 };
  }

  const stopsWithDistance = stopsData.features.map(f => {
    const {distance, bearing} = getDistanceAndBearing(
      userLoc.latitude, userLoc.longitude,
      parseFloat(f.properties.Latitude), parseFloat(f.properties.Longitude)
    );
    return {...f, distance, bearing};
  });

  const nearestStops = stopsWithDistance.sort((a,b)=>a.distance-b.distance).slice(0,5);

  const tripsByStop = await loadRealtimeTrips();

  const container = document.getElementById('stops');
  container.innerHTML = '';

  for (const stop of nearestStops) {
    const stopNumber = parseInt(stop.properties.AtcoCode.slice(-6),10);
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

    const rtTrips = tripsByStop[stop.properties.AtcoCode] || [];
    // deduplicate by route+headsign+arrival_time
    const seen = new Set();
    for (const t of rtTrips) {
      const key = `${t.route_id}|${t.headsign}|${t.arrival_time}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const li = document.createElement('li');
      li.textContent = `${t.route_id} → ${t.headsign}`;
      if (t.arrival_time) {
        const dt = new Date(t.arrival_time);
        li.textContent += ` | Real-time: ${dt.getHours().toString().padStart(2,'0')}:${dt.getMinutes().toString().padStart(2,'0')}`;
      }

      arrivalsUl.appendChild(li);
    }

    stopDiv.appendChild(arrivalsUl);
    container.appendChild(stopDiv);
  }
}

document.addEventListener('DOMContentLoaded', renderStops);
