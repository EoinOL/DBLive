// app4.js - Mode A with real-time GTFS feed

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

// Load stops.geojson.gz (local)
async function loadStops() {
  try {
    const resp = await fetch('stops.geojson.gz');
    const compressed = new Uint8Array(await resp.arrayBuffer());
    const decompressed = pako.ungzip(compressed, { to: 'string' });
    const stops = JSON.parse(decompressed);
    console.log("Loaded stops.geojson:", stops.features.length, "stops");
    return stops;
  } catch(err) {
    console.error("Failed to load stops.geojson:", err);
    return {features: []};
  }
}

// Load scheduled stop JSON to augment RT data
async function loadStopJson(atcoCode) {
  try {
    const resp = await fetch(`stops/${atcoCode}.json`);
    if (!resp.ok) {
      console.warn(`Stop JSON not found for ${atcoCode}`);
      return null;
    }
    return await resp.json();
  } catch(err) {
    console.warn(`Error loading stop JSON for ${atcoCode}:`, err);
    return null;
  }
}

// Load all GTFS-RT trips from Cloudflare worker
async function loadRealtimeTrips() {
  try {
    const resp = await fetch('https://falling-firefly-fd90.eoinol.workers.dev/');
    if (!resp.ok) throw new Error(`GTFS-RT fetch failed: ${resp.status}`);
    const data = await resp.json();

    // Logging raw response
    console.log("Raw GTFS-RT feed:", data);

    if (!data || !data.entity) {
      console.error("GTFS-RT data missing 'entity':", data);
      return {};
    }

    const tripsByStop = {};

    data.entity.forEach(e => {
      if (!e.trip_update || !e.trip_update.stop_time_update) return;
      const trip = e.trip_update.trip;
      e.trip_update.stop_time_update.forEach(stu => {
        const stop = stu.stop_id;
        if (!tripsByStop[stop]) tripsByStop[stop] = [];
        tripsByStop[stop].push({
          trip_id: trip?.trip_id || "unknown",
          route_id: trip?.route_id || "Unknown",
          headsign: trip?.headsign || "Unknown",
          arrival_time: stu.arrival?.time ? new Date(stu.arrival.time*1000).toISOString() : null
        });
      });
    });

    console.log("Trips by stop loaded:", Object.keys(tripsByStop).length);
    return tripsByStop;
  } catch(err) {
    console.error("Failed to fetch GTFS-RT:", err);
    return {};
  }
}

// Main render function
async function renderStops() {
  const stopsData = await loadStops();

  // Get user location
  let userLoc = null;
  try {
    userLoc = await new Promise((res, rej) => {
      navigator.geolocation.getCurrentPosition(pos => res(pos.coords), err => rej(err));
    });
  } catch(err) {
    console.warn("Failed to get user location:", err);
  }

  // Compute nearest 5 stops
  const stopsWithDistance = stopsData.features.map(f => {
    if (!userLoc) return {...f, distance: 0, bearing: "N"};
    const {distance, bearing} = getDistanceAndBearing(
      userLoc.latitude, userLoc.longitude,
      parseFloat(f.properties.Latitude), parseFloat(f.properties.Longitude)
    );
    return {...f, distance, bearing};
  });

  const nearestStops = stopsWithDistance.sort((a,b) => a.distance - b.distance).slice(0,5);

  // Load RT trips once
  const realtimeTrips = await loadRealtimeTrips();

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

    stopDiv.appendChild(stopHeader);
    stopDiv.appendChild(distanceEl);

    // Trips for this stop (from RT)
    const trips = realtimeTrips[stop.properties.AtcoCode] || [];
    const seenTripIds = new Set();

    const arrivalsUl = document.createElement('ul');

    for (const t of trips) {
      if (seenTripIds.has(t.trip_id)) continue; // deduplicate
      seenTripIds.add(t.trip_id);

      const li = document.createElement('li');

      let realTimeStr = t.arrival_time ? `Real-time: ${t.arrival_time.split("T")[1].split(".")[0]}` : "";
      let schedStr = ""; // could load scheduled JSON here if needed

      li.textContent = `${t.route_id} → ${t.headsign}${realTimeStr ? ` | ${realTimeStr}` : ""}${schedStr ? ` | Scheduled: ${schedStr}` : ""}`;
      arrivalsUl.appendChild(li);
    }

    stopDiv.appendChild(arrivalsUl);
    container.appendChild(stopDiv);
  }
}

// Run on page load
document.addEventListener('DOMContentLoaded', renderStops);
