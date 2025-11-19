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

  const a = Math.sin(Δφ/2) ** 2 +
            Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ/2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  const distance = R * c;

  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1)*Math.sin(φ2) -
            Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ);
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

// Load GTFS-RT from our Cloudflare worker
async function loadRealtimeTrips() {
  const url = "https://falling-firefly-fd90.eoinol.workers.dev/";
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`GTFS-RT fetch failed: ${resp.status}`);
    const data = await resp.json();
    console.log("Raw GTFS-RT feed:", data);
    return data.arrivals || [];
  } catch (err) {
    console.error(err);
    return [];
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
  } catch {
    alert("Cannot determine location");
    return;
  }

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

  const realtimeArrivals = await loadRealtimeTrips();

  for (const stop of nearestStops) {
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

    // filter only trips for this stop
    const stopArrivals = realtimeArrivals.filter(a => a.AtcoCode === stop.properties.AtcoCode);

    const arrivalsUl = document.createElement('ul');
    for (const a of stopArrivals) {
      const li = document.createElement('li');
      let line = a.Line || "Unknown";
      let dest = a.Destination || "Unknown";
      let realtime = a.ExpectedArrival ? new Date(a.ExpectedArrival).toLocaleTimeString() : null;

      li.textContent = realtime
        ? `${line} → ${dest} | Real-time: ${realtime}`
        : `${line} → ${dest}`;

      arrivalsUl.appendChild(li);
    }

    stopDiv.appendChild(arrivalsUl);
    container.appendChild(stopDiv);
  }
}

document.addEventListener('DOMContentLoaded', renderStops);
