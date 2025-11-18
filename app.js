// Convert degrees to 8-point compass
function degToCompass(deg) {
  const val = Math.floor((deg / 45) + 0.5);
  const compassPoints = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return compassPoints[val % 8];
}

// Calculate distance and bearing
function getDistanceAndBearing(lat1, lon1, lat2, lon2) {
  const R = 6371000; // meters
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

  return { distance: Math.round(distance), bearing: degToCompass(bearingDeg) };
}

// Load stops.geojson.gz
async function loadStops() {
  try {
    const resp = await fetch('stops.geojson.gz');
    const compressed = new Uint8Array(await resp.arrayBuffer());
    const decompressed = pako.ungzip(compressed, { to: 'string' });
    return JSON.parse(decompressed);
  } catch (err) {
    console.error("Error loading stops.geojson.gz:", err);
    return null;
  }
}

// Load stop JSON from R2 safely
async function loadStopJson(atcoCode) {
  if (!atcoCode) {
    console.warn("Undefined AtcoCode requested");
    return null;
  }
  const url = `https://pub-aad94a89c9ea4f6390466b521c65d978.r2.dev/stops/${atcoCode}.json`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      console.warn(`Stop ${atcoCode} not found (HTTP ${resp.status})`);
      return null;
    }
    return await resp.json();
  } catch (err) {
    console.warn(`Error loading stop ${atcoCode}`, err);
    return null;
  }
}

// Filter arrivals (currently just logs everything for debugging)
function filterArrivals(arrivals) {
  if (!arrivals || !Array.isArray(arrivals)) return [];
  return arrivals; // no filtering yet; logging only
}

// Main render
async function renderStops() {
  const stopsData = await loadStops();
  if (!stopsData) return;

  let userLoc;
  try {
    userLoc = await new Promise((res, rej) => {
      navigator.geolocation.getCurrentPosition(p => res(p.coords), e => rej(e));
    });
  } catch(err) {
    console.error("Cannot get location:", err);
    document.getElementById('stops').textContent = "Cannot determine location.";
    return;
  }

  const stopsWithDistance = stopsData.features.map(f => {
    const lat = parseFloat(f.properties.Latitude);
    const lon = parseFloat(f.properties.Longitude);
    if (isNaN(lat) || isNaN(lon)) {
      console.warn("Invalid coordinates for stop:", f);
      return { ...f, distance: Infinity, bearing: '?' };
    }
    const { distance, bearing } = getDistanceAndBearing(userLoc.latitude, userLoc.longitude, lat, lon);
    return { ...f, distance, bearing };
  });

  const nearestStops = stopsWithDistance.sort((a,b) => a.distance - b.distance).slice(0,5);
  const container = document.getElementById('stops');
  container.innerHTML = '';

  for (const stop of nearestStops) {
    const arrivals = await loadStopJson(stop.properties.AtcoCode);
    const filteredArrivals = filterArrivals(arrivals);

    const atco = stop.properties.AtcoCode || '';
    const stopNumber = atco ? parseInt(atco.slice(-6), 10) : 'unknown';
    const mapsLink = `https://www.google.com/maps/search/?api=1&query=${stop.properties.Latitude},${stop.properties.Longitude}`;

    const stopDiv = document.createElement('div');
    stopDiv.className = 'stop';

    const stopHeader = document.createElement('h3');
    stopHeader.textContent = `${stop.properties.SCN_English || 'Unknown'} (#${stopNumber})`;

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
    if (filteredArrivals.length === 0) {
      const li = document.createElement('li');
      li.textContent = "No arrivals found (or data not available).";
      arrivalsUl.appendChild(li);
    } else {
      filteredArrivals.forEach(a => {
        const li = document.createElement('li');
        li.textContent = `${a.route_short || '?'} → ${a.trip_headsign || '?'} at ${a.arrival_time || '?'}`;
        arrivalsUl.appendChild(li);
      });
    }

    stopDiv.appendChild(arrivalsUl);
    container.appendChild(stopDiv);
  }
}

document.addEventListener('DOMContentLoaded', renderStops);
