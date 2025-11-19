// Convert degrees to 8-point compass
function degToCompass(deg) {
  const val = Math.floor((deg / 45) + 0.5);
  const compassPoints = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return compassPoints[val % 8];
}

// Distance and bearing
function getDistanceAndBearing(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(Δφ/2)**2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ/2)**2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  const distance = R * c;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ);
  const bearingDeg = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  return {distance: Math.round(distance), bearing: degToCompass(bearingDeg)};
}

// Load stops
async function loadStops() {
  const resp = await fetch('stops.geojson.gz');
  const compressed = new Uint8Array(await resp.arrayBuffer());
  const decompressed = pako.ungzip(compressed, { to: 'string' });
  return JSON.parse(decompressed);
}

// Load GTFS-RT feed
async function loadRealtimeTrips() {
  const resp = await fetch('https://falling-firefly-fd90.eoinol.workers.dev/');
  if (!resp.ok) throw new Error(`GTFS-RT fetch failed: ${resp.status}`);
  const data = await resp.json();
  console.log("Raw GTFS-RT feed:", data);
  return data.arrivals;
}

// Load trips.txt.gz and build trip_id -> {route, headsign} map
async function loadScheduledTrips() {
  const resp = await fetch('trips.txt.gz');
  const compressed = new Uint8Array(await resp.arrayBuffer());
  const decompressed = pako.ungzip(compressed, { to: 'string' });
  
  const lines = decompressed.split('\n');
  const headers = lines[0].split(',');
  const tripIdIdx = headers.indexOf('trip_id');
  const routeIdIdx = headers.indexOf('route_id');
  const headsignIdx = headers.indexOf('trip_headsign');

  const map = {};
  lines.slice(1).forEach(line => {
    if (!line.trim()) return;
    const cols = line.split(',');
    const trip_id = cols[tripIdIdx];
    map[trip_id] = {
      route: cols[routeIdIdx] || 'Unknown',
      headsign: cols[headsignIdx] || 'Unknown'
    };
  });
  console.log("Scheduled trips loaded:", Object.keys(map).length);
  return map;
}

// Main
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

  const nearestStops = stopsWithDistance.sort((a,b) => a.distance - b.distance).slice(0,5);
  const container = document.getElementById('stops');
  container.innerHTML = '';

  const realtimeTrips = await loadRealtimeTrips();
  const scheduledMap = await loadScheduledTrips();

  console.log("Total GTFS-RT trips:", realtimeTrips.length);

  for (const stop of nearestStops) {
    const stopDiv = document.createElement('div');
    stopDiv.className = 'stop';

    const stopNumber = parseInt(stop.properties.AtcoCode.slice(-6), 10);
    const mapsLink = `https://www.google.com/maps/search/?api=1&query=${stop.properties.Latitude},${stop.properties.Longitude}`;

    const stopHeader = document.createElement('h3');
    stopHeader.textContent = `${stop.properties.SCN_English} (#${stopNumber})`;
    stopDiv.appendChild(stopHeader);

    const distanceEl = document.createElement('a');
    distanceEl.href = mapsLink;
    distanceEl.target = '_blank';
    distanceEl.textContent = `${stop.distance} m`;
    stopDiv.appendChild(distanceEl);

    const bearingEl = document.createElement('span');
    bearingEl.textContent = ` • ${stop.bearing}`;
    stopDiv.appendChild(bearingEl);

    const arrivalsUl = document.createElement('ul');

    const stopTrips = realtimeTrips.filter(t => t.stop_id === stop.properties.AtcoCode);
    stopTrips.forEach(trip => {
      const info = scheduledMap[trip.trip_id] || {route: "Unknown", headsign: "Unknown"};
      const li = document.createElement('li');
      li.textContent = `${info.route} → ${info.headsign}`;
      arrivalsUl.appendChild(li);
    });

    stopDiv.appendChild(arrivalsUl);
    container.appendChild(stopDiv);
  }
}

document.addEventListener('DOMContentLoaded', renderStops);
