// app4.js

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

  const a = Math.sin(Δφ/2)**2 +
            Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ/2)**2;
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

// Load trips.txt.gz and build mapping: trip_id -> {route_short, trip_headsign}
async function loadTripsMapping() {
  const resp = await fetch('trips.txt.gz');
  const compressed = new Uint8Array(await resp.arrayBuffer());
  const decompressed = pako.ungzip(compressed, { to: 'string' });
  const lines = decompressed.split('\n');
  const mapping = {};
  const headers = lines.shift().split(',');

  lines.forEach(line => {
    if (!line.trim()) return;
    const parts = line.split(',');
    const trip = {};
    headers.forEach((h, idx) => trip[h] = parts[idx]);
    if (trip.trip_id) {
      mapping[trip.trip_id] = {
        route_short: trip.route_short || 'Unknown',
        trip_headsign: trip.trip_headsign || 'Unknown'
      };
    }
  });
  console.log('Trips mapping loaded:', Object.keys(mapping).length);
  return mapping;
}

// Load GTFS-RT via Cloudflare worker
async function loadRealtimeTrips() {
  try {
    const resp = await fetch('https://falling-firefly-fd90.eoinol.workers.dev/');
    if (!resp.ok) throw new Error(`GTFS-RT fetch failed: ${resp.status}`);
    const data = await resp.json();
    console.log('Raw GTFS-RT feed:', data);
    return data.arrivals || [];
  } catch (err) {
    console.error('Failed to fetch GTFS-RT:', err);
    return [];
  }
}

// Main render function
async function renderStops() {
  const stopsData = await loadStops();
  const tripsMapping = await loadTripsMapping();
  const realtimeArrivals = await loadRealtimeTrips();

  // Get user location
  let userLoc;
  try {
    userLoc = await new Promise((res, rej) => {
      navigator.geolocation.getCurrentPosition(pos => res(pos.coords), err => rej(err));
    });
  } catch (err) {
    console.warn('Location not available, showing stops at 0m');
    userLoc = { latitude: 0, longitude: 0 };
  }

  // Compute distance to each stop
  const stopsWithDistance = stopsData.features.map(f => {
    const {distance, bearing} = getDistanceAndBearing(
      userLoc.latitude, userLoc.longitude,
      parseFloat(f.properties.Latitude), parseFloat(f.properties.Longitude)
    );
    return {...f, distance, bearing};
  });

  // Nearest 5 stops
  const nearestStops = stopsWithDistance.sort((a,b) => a.distance - b.distance).slice(0,5);

  const container = document.getElementById('stops');
  container.innerHTML = '';

  for (const stop of nearestStops) {
    const stopArrivals = realtimeArrivals.filter(a => a.atco === stop.properties.AtcoCode);

    const stopDiv = document.createElement('div');
    stopDiv.className = 'stop';

    const stopHeader = document.createElement('h3');
    stopHeader.textContent = `${stop.properties.SCN_English} (#${parseInt(stop.properties.AtcoCode.slice(-6),10)})`;
    stopDiv.appendChild(stopHeader);

    const distanceEl = document.createElement('span');
    distanceEl.textContent = `${stop.distance} m • ${stop.bearing}`;
    stopDiv.appendChild(distanceEl);

    const mapsLink = document.createElement('a');
    mapsLink.href = `https://www.google.com/maps/search/?api=1&query=${stop.properties.Latitude},${stop.properties.Longitude}`;
    mapsLink.target = '_blank';
    mapsLink.textContent = ' [Map]';
    stopDiv.appendChild(mapsLink);

    const arrivalsUl = document.createElement('ul');

    stopArrivals.forEach(a => {
      const info = tripsMapping[a.trip_id] || {route_short: 'Unknown', trip_headsign: 'Unknown'};
      const li = document.createElement('li');
      li.textContent = `${info.route_short} → ${info.trip_headsign} | Real-time: ${a.ExpectedArrival ? new Date(a.ExpectedArrival).toLocaleTimeString() : 'Unknown'}`;
      arrivalsUl.appendChild(li);
    });

    stopDiv.appendChild(arrivalsUl);
    container.appendChild(stopDiv);
  }
}

// Run on page load
document.addEventListener('DOMContentLoaded', renderStops);
