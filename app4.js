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

  const a = Math.sin(Δφ/2)**2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ/2)**2;
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

// Load GTFS-RT via Cloudflare worker
async function loadRealtimeTrips() {
  const resp = await fetch('https://falling-firefly-fd90.eoinol.workers.dev/');
  if (!resp.ok) throw new Error(`GTFS-RT fetch failed: ${resp.status}`);
  const data = await resp.json();
  console.log("Raw GTFS-RT feed:", data);
  return data.arrivals;
}

// Load scheduled trip info (trip_id -> route/headsign/time)
async function loadScheduledTrips() {
  const resp = await fetch('trips.json'); // your full scheduled trips JSON
  const trips = await resp.json();
  const map = {};
  trips.forEach(t => {
    t.stop_time_update?.forEach(stu => {
      map[stu.trip_id] = {
        route: t.trip_update.trip.route_id,
        headsign: t.trip_update.trip.trip_headsign || "Unknown",
        scheduled_time: stu.arrival?.time || stu.departure?.time
      };
    });
  });
  return map;
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

  // Load GTFS data
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

    // Filter GTFS-RT trips for this stop
    const stopTrips = realtimeTrips.filter(t => t.stop_id === stop.properties.AtcoCode);
    stopTrips.forEach(trip => {
      const info = scheduledMap[trip.trip_id] || {route: "Unknown", headsign: "Unknown", scheduled_time: null};
      const li = document.createElement('li');
      let timeStr = info.scheduled_time ? new Date(info.scheduled_time * 1000).toISOString().substr(11,8) : "Unknown";
      li.textContent = `${info.route} → ${info.headsign} | Scheduled: ${timeStr}`;
      arrivalsUl.appendChild(li);
    });

    stopDiv.appendChild(arrivalsUl);
    container.appendChild(stopDiv);
  }
}

document.addEventListener('DOMContentLoaded', renderStops);
