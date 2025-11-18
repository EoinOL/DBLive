// app.js

// Convert degrees to 8-point compass
function degToCompass(deg) {
  const val = Math.floor((deg / 45) + 0.5);
  const compassPoints = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return compassPoints[val % 8];
}

// Calculate distance and bearing between two lat/lon points
function getDistanceAndBearing(lat1, lon1, lat2, lon2) {
  const R = 6371000; // meters
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;

  // distance
  const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ/2) * Math.sin(Δλ/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  const distance = R * c;

  // bearing
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1)*Math.sin(φ2) -
            Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ);
  const bearingDeg = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;

  return {distance: Math.round(distance), bearing: degToCompass(bearingDeg)};
}

// Load stops.geojson.gz using pako
async function loadStops() {
  const resp = await fetch('stops.geojson.gz');
  const compressed = new Uint8Array(await resp.arrayBuffer());
  const decompressed = pako.ungzip(compressed, { to: 'string' });
  return JSON.parse(decompressed);
}

// Load stop JSON from R2 safely
async function loadStopJson(atcoCode) {
  const url = `https://pub-aad94a89c9ea4f6390466b521c65d978.r2.dev/stops/${atcoCode}.json`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      console.warn(`Stop ${atcoCode} not found (HTTP ${resp.status})`);
      return null;
    }
    const data = await resp.json();
    return data;
  } catch (err) {
    console.warn(`Error loading stop ${atcoCode}`, err);
    return null;
  }
}

// Filter arrivals: today + last 30m / next 60m
function filterArrivals(arrivals) {
  const now = new Date();
  const startTime = new Date(now.getTime() - 30 * 60 * 1000);
  const endTime = new Date(now.getTime() + 60 * 60 * 1000);

  const todayStr = now.toISOString().split('T')[0];

  const filtered = arrivals
    .filter(a => {
      const t = new Date();
      const parts = a.arrival_time.split(':');
      t.setHours(parseInt(parts[0]), parseInt(parts[1]), parseInt(parts[2]));
      return t >= startTime && t <= endTime;
    })
    // deduplicate by trip_id
    .filter((a, idx, arr) => arr.findIndex(b => b.trip_id === a.trip_id) === idx);

  return filtered.sort((a,b) => a.arrival_time.localeCompare(b.arrival_time));
}

// Main render function
async function renderStops() {
  const stopsData = await loadStops();
  const userLoc = await new Promise((res, rej) => {
    navigator.geolocation.getCurrentPosition(pos => res(pos.coords), err => rej(err));
  });

  const stopsWithDistance = stopsData.features.map(f => {
    const {distance, bearing} = getDistanceAndBearing(
      userLoc.latitude, userLoc.longitude,
      parseFloat(f.properties.Latitude), parseFloat(f.properties.Longitude)
    );
    return {...f, distance, bearing};
  });

  // nearest 5 stops
  const nearestStops = stopsWithDistance.sort((a,b) => a.distance - b.distance).slice(0,5);

  const container = document.getElementById('stops');
  container.innerHTML = '';

  for (const stop of nearestStops) {
    const arrivals = await loadStopJson(stop.properties.AtcoCode);
    const filteredArrivals = arrivals ? filterArrivals(arrivals) : [];

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
    bearingEl.textContent = ` (${stop.bearing})`;

    stopDiv.appendChild(stopHeader);
    stopDiv.appendChild(distanceEl);
    stopDiv.appendChild(bearingEl);

    const arrivalsUl = document.createElement('ul');
    for (const a of filteredArrivals) {
      const li = document.createElement('li');
      li.textContent = `${a.route_short} → ${a.trip_headsign} at ${a.arrival_time}`;
      arrivalsUl.appendChild(li);
    }
    stopDiv.appendChild(arrivalsUl);
    container.appendChild(stopDiv);
  }
}

// Run on page load
document.addEventListener('DOMContentLoaded', renderStops);
