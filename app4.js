// Convert degrees to 8-point compass
function degToCompass(deg) {
  const val = Math.floor((deg / 45) + 0.5);
  const compassPoints = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return compassPoints[val % 8];
}

// Calculate distance and bearing
function getDistanceAndBearing(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  const distance = R * c;

  const y = Math.sin(Δλ)*Math.cos(φ2);
  const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ);
  const bearingDeg = (Math.atan2(y, x)*180/Math.PI + 360)%360;

  return { distance: Math.round(distance), bearing: degToCompass(bearingDeg) };
}

// Load stops.geojson.gz
async function loadStops() {
  const resp = await fetch('stops.geojson.gz');
  const compressed = new Uint8Array(await resp.arrayBuffer());
  const decompressed = pako.ungzip(compressed, { to: 'string' });
  return JSON.parse(decompressed);
}

// Load GTFS real-time feed from worker
async function loadRealtimeTrips() {
  try {
    const resp = await fetch('https://falling-firefly-fd90.eoinol.workers.dev/');
    const data = await resp.json();
    console.log("Raw GTFS-RT feed:", data);
    return data.arrivals || [];
  } catch (err) {
    console.error("Failed to fetch GTFS-RT:", err);
    return [];
  }
}

async function loadScheduledTrips() {
  try {
    const resp = await fetch('trips.txt.gz');
    const compressed = new Uint8Array(await resp.arrayBuffer());
    const decompressed = pako.ungzip(compressed, { to: 'string' });

    const lines = decompressed.split('\n').filter(l => l.trim() !== '');
    const header = lines.shift().split(','); // first line is header

    const mapping = {};
    for (const line of lines) {
      const cols = line.split(',');
      if (cols.length < header.length) continue; // skip malformed lines
      const trip_id = cols[2];
      const route_short_name = cols[0];
      const trip_headsign = cols[3];
      if (trip_id) mapping[trip_id] = { route: route_short_name, headsign: trip_headsign };
    }
    console.log("Loaded scheduled trips:", Object.keys(mapping).length);
    return mapping;

  } catch (err) {
    console.error("Failed to load scheduled trips:", err);
    return {};
  }
}

// Render nearest 5 stops
async function renderStops() {
  const stopsData = await loadStops();
  let userLoc;
  try {
    userLoc = await new Promise((res, rej) => {
      navigator.geolocation.getCurrentPosition(p => res(p.coords), err => rej(err));
    });
  } catch {
    console.warn("Location not available, defaulting to first stop coordinates");
    userLoc = { latitude: parseFloat(stopsData.features[0].properties.Latitude), longitude: parseFloat(stopsData.features[0].properties.Longitude) };
  }

  const stopsWithDistance = stopsData.features.map(f => {
    const { distance, bearing } = getDistanceAndBearing(
      userLoc.latitude, userLoc.longitude,
      parseFloat(f.properties.Latitude), parseFloat(f.properties.Longitude)
    );
    return { ...f, distance, bearing };
  });

  const nearestStops = stopsWithDistance.sort((a,b)=>a.distance-b.distance).slice(0,5);

  const realtimeArrivals = await loadRealtimeTrips();
  const scheduledMapping = await loadScheduledTrips();

  const container = document.getElementById('stops');
  container.innerHTML = '';

  for (const stop of nearestStops) {
    const stopDiv = document.createElement('div');
    stopDiv.className = 'stop';

    const stopNumber = parseInt(stop.properties.AtcoCode.slice(-6),10);
    const mapsLink = `https://www.google.com/maps/search/?api=1&query=${stop.properties.Latitude},${stop.properties.Longitude}`;
    const stopHeader = document.createElement('h3');
    stopHeader.textContent = `${stop.properties.SCN_English} (#${stopNumber})`;
    const distanceEl = document.createElement('span');
    distanceEl.textContent = `${stop.distance} m • ${stop.bearing}`;
    const mapsEl = document.createElement('a');
    mapsEl.href = mapsLink;
    mapsEl.target = '_blank';
    mapsEl.textContent = '[Map]';

    stopDiv.appendChild(stopHeader);
    stopDiv.appendChild(distanceEl);
    stopDiv.appendChild(mapsEl);

    const arrivalsUl = document.createElement('ul');

    // Show trips from GTFS-RT for this stop
    for (const a of realtimeArrivals) {
      const scheduled = scheduledMapping[a.Line] || { route: a.Line, headsign: a.Destination };
      const li = document.createElement('li');
      li.textContent = `${scheduled.route} → ${scheduled.headsign}`;
      arrivalsUl.appendChild(li);
    }

    stopDiv.appendChild(arrivalsUl);
    container.appendChild(stopDiv);
  }
}

document.addEventListener('DOMContentLoaded', renderStops);
