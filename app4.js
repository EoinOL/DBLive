// Convert degrees to 8-point compass
function degToCompass(deg) {
  const val = Math.floor((deg / 45) + 0.5);
  const compassPoints = ["N","NE","E","SE","S","SW","W","NW"];
  return compassPoints[val % 8];
}

// Calculate distance and bearing between two lat/lon points
function getDistanceAndBearing(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const φ1 = lat1 * Math.PI/180;
  const φ2 = lat2 * Math.PI/180;
  const Δφ = (lat2-lat1)*Math.PI/180;
  const Δλ = (lon2-lon1)*Math.PI/180;

  const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  const c = 2*Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  const distance = R * c;

  const y = Math.sin(Δλ)*Math.cos(φ2);
  const x = Math.cos(φ1)*Math.sin(φ2)-Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ);
  const bearingDeg = (Math.atan2(y,x)*180/Math.PI + 360) % 360;

  return { distance: Math.round(distance), bearing: degToCompass(bearingDeg) };
}

// Load stops.geojson.gz
async function loadStops() {
  const resp = await fetch('stops.geojson.gz');
  const compressed = new Uint8Array(await resp.arrayBuffer());
  const decompressed = pako.ungzip(compressed, { to: 'string' });
  return JSON.parse(decompressed);
}

// Load GTFS-RT from Cloudflare worker
async function loadRealtimeTrips() {
  const url = 'https://falling-firefly-fd90.eoinol.workers.dev/';
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`GTFS-RT fetch failed: ${resp.status}`);
  const data = await resp.json();
  return data.arrivals || [];
}

// Load stop JSON from R2 bucket
const R2_BUCKET = 'https://pub-aad94a89c9ea4f6390466b521c65d978.r2.dev/stops/';
async function loadStopJson(atco) {
  try {
    const resp = await fetch(`${R2_BUCKET}${atco}.json`);
    if (!resp.ok) return null;
    return await resp.json();
  } catch (err) {
    console.warn(`Error loading stop JSON ${atco}:`, err);
    return null;
  }
}

// Main render
async function renderStops() {
  const stopsData = await loadStops();

  // Get user location
  let userLoc;
  try {
    userLoc = await new Promise((res, rej) =>
      navigator.geolocation.getCurrentPosition(pos => res(pos.coords), err => rej(err))
    );
  } catch (err) {
    alert('Could not get location: ' + err.message);
    return;
  }

  // Compute distances
  const stopsWithDistance = stopsData.features.map(f => {
    const {distance, bearing} = getDistanceAndBearing(
      userLoc.latitude, userLoc.longitude,
      parseFloat(f.properties.Latitude), parseFloat(f.properties.Longitude)
    );
    return {...f, distance, bearing};
  });

  // Nearest 5 stops
  const nearestStops = stopsWithDistance.sort((a,b) => a.distance-b.distance).slice(0,5);

  // Load GTFS-RT
  let gtfsRT = [];
  try {
    gtfsRT = await loadRealtimeTrips();
  } catch (err) {
    console.error(err);
  }

  const container = document.getElementById('stops');
  container.innerHTML = '';

  for (const stop of nearestStops) {
    const stopNumber = parseInt(stop.properties.AtcoCode.slice(-6), 10);
    const mapsLink = `https://www.google.com/maps/search/?api=1&query=${stop.properties.Latitude},${stop.properties.Longitude}`;

    const stopDiv = document.createElement('div');
    stopDiv.className = 'stop';

    const stopHeader = document.createElement('h3');
    stopHeader.textContent = `${stop.properties.SCN_English} (#${stopNumber})`;
    const distanceEl = document.createElement('span');
    distanceEl.textContent = `${stop.distance} m • ${stop.bearing}`;
    stopHeader.appendChild(distanceEl);

    stopDiv.appendChild(stopHeader);

    // Load stop JSON to map trip_id -> route_short
    const stopJson = await loadStopJson(stop.properties.AtcoCode);

    // Filter GTFS-RT arrivals for this stop
    const arrivals = gtfsRT.filter(a => a.stop_id === stop.properties.AtcoCode);

    // Deduplicate by trip_id
    const seenTrips = new Set();
    const uniqueArrivals = arrivals.filter(a => {
      if (!a.trip_id) return false;
      if (seenTrips.has(a.trip_id)) return false;
      seenTrips.add(a.trip_id);
      return true;
    });

    const arrivalsUl = document.createElement('ul');
    if (uniqueArrivals.length === 0) {
      const li = document.createElement('li');
      li.textContent = 'No real-time trips available';
      arrivalsUl.appendChild(li);
    } else {
      for (const a of uniqueArrivals) {
        const li = document.createElement('li');

        // Map trip_id to route_short using stop JSON
        let route = 'Unknown';
        let headsign = 'Unknown';
        if (stopJson && a.trip_id && stopJson[a.trip_id]) {
          route = stopJson[a.trip_id].route_short || 'Unknown';
          headsign = stopJson[a.trip_id].trip_headsign || 'Unknown';
        } else {
          route = a.route || a.Line || 'Unknown';
          headsign = a.headsign || a.Destination || 'Unknown';
        }

        let text = `${route} → ${headsign}`;
        if (a.ExpectedArrival) {
          const dt = new Date(a.ExpectedArrival);
          text += ` | Real-time: ${dt.toLocaleTimeString()}`;
        }
        li.textContent = text;
        arrivalsUl.appendChild(li);
      }
    }

    stopDiv.appendChild(arrivalsUl);
    container.appendChild(stopDiv);
  }
}

// Run
document.addEventListener('DOMContentLoaded', renderStops);
