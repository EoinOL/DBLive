// Convert degrees to 8-point compass
function degToCompass(deg) {
  const val = Math.floor((deg / 45) + 0.5);
  const compassPoints = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return compassPoints[val % 8];
}

// Haversine distance and bearing
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
  const decompressed = pako.ungzip(compressed, {to: 'string'});
  return JSON.parse(decompressed);
}

// Fetch GTFS-RT TripUpdates from your worker
async function loadGTFSRT() {
  const resp = await fetch('/workers/falling-firefly-fd90'); // Replace with your worker URL if needed
  const data = await resp.json();
  return data.entity || [];
}

// Find arrivals for a stop by AtcoCode
function getArrivalsForStop(stopId, entities) {
  const arrivals = [];
  for (const e of entities) {
    if (!e.tripUpdate) continue;
    for (const stu of e.tripUpdate.stopTimeUpdate || []) {
      if (stu.stopId === stopId && stu.arrival) {
        const t = new Date(stu.arrival.time * 1000);
        arrivals.push({
          route_short: e.tripUpdate.trip.routeId,
          trip_headsign: e.tripUpdate.trip.tripHeadsign || '',
          arrival_time: t.toLocaleTimeString()
        });
      }
    }
  }
  return arrivals;
}

// Main render
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

  const gtfsEntities = await loadGTFSRT();

  const container = document.getElementById('stops');
  container.innerHTML = '';

  for (const stop of nearestStops) {
    const arrivals = getArrivalsForStop(stop.properties.AtcoCode, gtfsEntities);

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
    for (const a of arrivals) {
      const li = document.createElement('li');
      li.textContent = `${a.route_short} → ${a.trip_headsign} at ${a.arrival_time}`;
      arrivalsUl.appendChild(li);
    }
    stopDiv.appendChild(arrivalsUl);
    container.appendChild(stopDiv);
  }
}

// Run
document.addEventListener('DOMContentLoaded', renderStops);
