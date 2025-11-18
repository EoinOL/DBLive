// app.js

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

  const a = Math.sin(Δφ/2)**2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ/2)**2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  const distance = R * c;

  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ);
  const bearingDeg = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;

  return { distance: Math.round(distance), bearing: degToCompass(bearingDeg) };
}

// Load stops.geojson.gz
async function loadStops() {
  const resp = await fetch('stops.geojson.gz');
  const compressed = new Uint8Array(await resp.arrayBuffer());
  const decompressed = pako.ungzip(compressed, { to: 'string' });
  return JSON.parse(decompressed);
}

// Load stop JSON from R2
async function loadStopJson(atcoCode) {
  const url = `https://pub-aad94a89c9ea4f6390466b521c65d978.r2.dev/stops/${atcoCode}.json`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return await resp.json();
  } catch (err) {
    console.warn(`Error loading stop ${atcoCode}`, err);
    return null;
  }
}

// Load CSV (simple parser)
async function loadCSV(url) {
  const resp = await fetch(url);
  const text = await resp.text();
  const lines = text.split(/\r?\n/);
  const headers = lines[0].split(',');
  return lines.slice(1).map(line => {
    const values = line.split(',');
    const obj = {};
    headers.forEach((h, i) => { obj[h] = values[i]; });
    return obj;
  });
}

// Build service_id → active days map
async function loadGTFSMapping() {
  const calendar = await loadCSV('calendar.txt');
  const calendarDates = await loadCSV('calendar_dates.txt');

  const dayMap = {}; // service_id -> [day strings]

  const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

  // From calendar.txt
  calendar.forEach(row => {
    const days = [];
    dayNames.forEach((day, idx) => {
      if (row[day.toLowerCase()] === '1') days.push(day);
    });
    dayMap[row.service_id] = days;
  });

  // Override/add exceptions from calendar_dates.txt
  calendarDates.forEach(row => {
    const d = new Date(row.date.slice(0,4)+'-'+row.date.slice(4,6)+'-'+row.date.slice(6,8));
    const dayName = dayNames[d.getDay()];
    if (!dayMap[row.service_id]) dayMap[row.service_id] = [];
    if (row.exception_type === '1') { // added
      if (!dayMap[row.service_id].includes(dayName)) dayMap[row.service_id].push(dayName);
    } else if (row.exception_type === '2') { // removed
      const idx = dayMap[row.service_id].indexOf(dayName);
      if (idx >= 0) dayMap[row.service_id].splice(idx,1);
    }
  });

  return dayMap;
}

// Filter and annotate arrivals with days
async function processArrivals(arrivals, serviceDayMap, trips) {
  const annotated = arrivals.map(a => {
    const trip = trips.find(t => t.trip_id === a.trip_id);
    const serviceDays = trip ? (serviceDayMap[trip.service_id] || []) : [];
    return {...a, days: serviceDays};
  });

  // Group by route + headsign + time + days to remove duplicates
  const grouped = [];
  const seen = {};
  annotated.forEach(a => {
    const key = `${a.route_short}_${a.trip_headsign}_${a.arrival_time}_${a.days.join(',')}`;
    if (!seen[key]) {
      grouped.push(a);
      seen[key] = true;
    }
  });

  // Sort by arrival_time
  grouped.sort((a,b) => a.arrival_time.localeCompare(b.arrival_time));
  return grouped;
}

// Main render
async function renderStops() {
  const stopsData = await loadStops();

  let userLoc;
  try {
    userLoc = await new Promise((res, rej) => {
      navigator.geolocation.getCurrentPosition(pos => res(pos.coords), rej);
    });
  } catch(e) {
    console.warn('Cannot determine location', e);
    document.getElementById('stops').innerHTML = 'Cannot determine location';
    return;
  }

  const stopsWithDistance = stopsData.features.map(f => {
    const {distance, bearing} = getDistanceAndBearing(
      userLoc.latitude, userLoc.longitude,
      parseFloat(f.properties.Latitude), parseFloat(f.properties.Longitude)
    );
    return {...f, distance, bearing};
  });

  const nearestStops = stopsWithDistance.sort((a,b)=>a.distance-b.distance).slice(0,5);

  // Load GTFS mappings
  const serviceDayMap = await loadGTFSMapping();
  const trips = await loadCSV('trips.txt.gz'); // decompress if necessary

  const container = document.getElementById('stops');
  container.innerHTML = '';

  for (const stop of nearestStops) {
    const arrivals = await loadStopJson(stop.properties.AtcoCode);
    const processedArrivals = arrivals ? await processArrivals(arrivals, serviceDayMap, trips) : [];

    const stopNumber = parseInt(stop.properties.AtcoCode.slice(-6),10);
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
    for (const a of processedArrivals) {
      const li = document.createElement('li');
      li.textContent = `${a.route_short} → ${a.trip_headsign} at ${a.arrival_time} (${a.days.join(', ')})`;
      arrivalsUl.appendChild(li);
    }
    stopDiv.appendChild(arrivalsUl);
    container.appendChild(stopDiv);
  }
}

document.addEventListener('DOMContentLoaded', renderStops);
