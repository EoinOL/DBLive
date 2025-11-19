// Convert degrees to 8-point compass
function degToCompass(deg) {
  const val = Math.floor((deg / 45) + 0.5);
  const compassPoints = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return compassPoints[val % 8];
}

// Calculate distance and bearing between two lat/lon points
function getDistanceAndBearing(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  const distance = Math.round(R * c);

  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ);
  const bearingDeg = (Math.atan2(y,x)*180/Math.PI + 360)%360;
  return {distance, bearing: degToCompass(bearingDeg)};
}

// Load stops.geojson.gz
async function loadStops() {
  const resp = await fetch('stops.geojson.gz');
  const compressed = new Uint8Array(await resp.arrayBuffer());
  const decompressed = pako.ungzip(compressed, { to: 'string' });
  return JSON.parse(decompressed);
}

// Load trips.txt.gz and build mapping of trip_id -> {route, headsign}
async function loadScheduledTrips() {
  const resp = await fetch('trips.txt.gz');
  const compressed = new Uint8Array(await resp.arrayBuffer());
  const decompressed = pako.ungzip(compressed, { to: 'string' });
  const trips = JSON.parse(decompressed);
  const map = {};
  trips.forEach(t => {
    map[t.trip_id] = { route: t.route_short || "Unknown", headsign: t.trip_headsign || "Unknown" };
  });
  return map;
}

// Load GTFS-RT feed via Cloudflare Worker
async function loadRealtimeTrips() {
  const resp = await fetch('https://falling-firefly-fd90.eoinol.workers.dev/');
  const data = await resp.json();
  if (!data.arrivals) {
    console.log("GTFS-RT missing arrivals:", data);
    return [];
  }
  return data.arrivals;
}

// Main render function
async function renderStops() {
  try {
    const stopsData = await loadStops();
    const scheduledMap = await loadScheduledTrips();
    const realtimeTrips = await loadRealtimeTrips();

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

    const nearestStops = stopsWithDistance.sort((a,b)=>a.distance-b.distance).slice(0,5);

    const container = document.getElementById('stops');
    container.innerHTML = '';

    nearestStops.forEach(stop => {
      const stopDiv = document.createElement('div');
      stopDiv.className = 'stop';

      const stopNumber = parseInt(stop.properties.AtcoCode.slice(-6),10);
      const stopHeader = document.createElement('h3');
      stopHeader.textContent = `${stop.properties.SCN_English} (#${stopNumber})`;

      const mapsLink = `https://www.google.com/maps/search/?api=1&query=${stop.properties.Latitude},${stop.properties.Longitude}`;
      const distanceEl = document.createElement('a');
      distanceEl.href = mapsLink;
      distanceEl.target = '_blank';
      distanceEl.textContent = `${stop.distance} m • ${stop.bearing}`;

      stopDiv.appendChild(stopHeader);
      stopDiv.appendChild(distanceEl);

      const arrivalsUl = document.createElement('ul');
      const stopTrips = realtimeTrips.filter(t => t.stop_id === stop.properties.AtcoCode);

      if (stopTrips.length === 0) {
        const li = document.createElement('li');
        li.textContent = 'No arrivals found';
        arrivalsUl.appendChild(li);
      } else {
        stopTrips.forEach(trip => {
          const info = scheduledMap[trip.trip_id] || {route:"Unknown", headsign:"Unknown"};
          const li = document.createElement('li');
          li.textContent = `${info.route} → ${info.headsign}`;
          arrivalsUl.appendChild(li);
        });
      }

      stopDiv.appendChild(arrivalsUl);
      container.appendChild(stopDiv);
    });

  } catch(err) {
    console.error("Error rendering stops:", err);
  }
}

document.addEventListener('DOMContentLoaded', renderStops);
