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

  const a = Math.sin(Δφ/2) ** 2 +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ/2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  const distance = R * c;

  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1)*Math.sin(φ2) -
            Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ);
  const bearingDeg = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;

  return {distance: Math.round(distance), bearing: degToCompass(bearingDeg)};
}

// Load stops.geojson.gz using pako
async function loadStops() {
  const resp = await fetch('stops.geojson.gz');
  const compressed = new Uint8Array(await resp.arrayBuffer());
  const decompressed = pako.ungzip(compressed, { to: 'string' });
  return JSON.parse(decompressed);
}

// Load stop JSON data (scheduled arrivals)
async function loadStopJson(atcoCode) {
  const url = `https://pub-aad94a89c9ea4f6390466b521c65d978.r2.dev/stops/${atcoCode}.json`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

// Load GTFS-RT feed (full feed)
async function loadRealtimeTrips() {
  const url = 'https://falling-firefly-fd90.eoinol.workers.dev/';
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`GTFS-RT fetch failed: ${resp.status}`);
  const data = await resp.json();
  return data.arrivals; // full feed
}

// Merge scheduled arrivals with RT feed for a stop
function mergeArrivals(stopAtco, scheduled, realtimeFeed) {
  // Filter RT trips relevant to this stop
  const rtTrips = realtimeFeed
    .filter(e => e.trip_update && e.trip_update.stop_time_update)
    .flatMap(e => e.trip_update.stop_time_update)
    .filter(stu => stu.stop_id === stopAtco)
    .map(stu => ({
      trip_id: stu.trip?.trip_id || stu.trip?.route_id,
      route_short: stu.trip?.route_id || "Unknown",
      trip_headsign: stu.trip?.headsign || "Unknown",
      expected_time: stu.arrival?.time ? new Date(stu.arrival.time * 1000).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'}) : null
    }));

  const scheduledList = scheduled ? scheduled.map(s => ({
    trip_id: s.trip_id,
    route_short: s.route_short,
    trip_headsign: s.trip_headsign,
    scheduled_time: s.arrival_time
  })) : [];

  // Merge by trip_id (if present in RT use RT, else show scheduled)
  const merged = [];

  rtTrips.forEach(rt => {
    const sch = scheduledList.find(s => s.trip_id === rt.trip_id);
    merged.push({
      route_short: rt.route_short,
      trip_headsign: rt.trip_headsign,
      expected_time: rt.expected_time,
      scheduled_time: sch ? sch.scheduled_time : null
    });
  });

  // Add scheduled trips that were not in RT feed
  scheduledList.forEach(sch => {
    if (!rtTrips.find(rt => rt.trip_id === sch.trip_id)) {
      merged.push({
        route_short: sch.route_short,
        trip_headsign: sch.trip_headsign,
        expected_time: null,
        scheduled_time: sch.scheduled_time
      });
    }
  });

  return merged;
}

// Main render function
async function renderStops() {
  try {
    const stopsData = await loadStops();
    const realtimeFeed = await loadRealtimeTrips();

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

    for (const stop of nearestStops) {
      const scheduled = await loadStopJson(stop.properties.AtcoCode);
      const merged = mergeArrivals(stop.properties.AtcoCode, scheduled, realtimeFeed);

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

      const arrivalsUl = document.createElement('ul');
      merged.forEach(a => {
        const li = document.createElement('li');
        li.textContent = `${a.route_short} → ${a.trip_headsign}` +
                         ` ${a.expected_time ? '| Real-time: ' + a.expected_time : ''}` +
                         ` ${a.scheduled_time ? '| Scheduled: ' + a.scheduled_time : ''}`;
        arrivalsUl.appendChild(li);
      });

      stopDiv.appendChild(arrivalsUl);
      container.appendChild(stopDiv);
    }

  } catch (err) {
    console.error('Error rendering stops:', err);
  }
}

// Run on page load
document.addEventListener('DOMContentLoaded', renderStops);
