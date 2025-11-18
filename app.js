// app.js
// Dependencies: pako

async function fetchText(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url}`);
    return await res.text();
}

async function fetchGzText(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url}`);
    const arrayBuffer = await res.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);
    return pako.ungzip(uint8Array, { to: 'string' });
}

// Simple CSV parser
function parseCSV(csvText) {
    const lines = csvText.split(/\r?\n/);
    const headers = lines.shift().split(',');
    return lines.filter(l => l.trim()).map(line => {
        const values = line.split(',');
        const obj = {};
        headers.forEach((h, i) => { obj[h] = values[i]; });
        return obj;
    });
}

// Convert day string to integer (0=Sunday..6=Saturday)
function getWeekdayIndex(day) {
    const map = { sunday:0, monday:1, tuesday:2, wednesday:3, thursday:4, friday:5, saturday:6 };
    return map[day.toLowerCase()];
}

// Load GTFS mapping for today's service_ids
async function loadGTFSMapping() {
    const [calendarText, calendarDatesText, tripsText] = await Promise.all([
        fetchText('calendar.txt'),
        fetchText('calendar_dates.txt'),
        fetchGzText('trips.txt.gz')
    ]);

    const calendar = parseCSV(calendarText);
    const calendarDates = parseCSV(calendarDatesText);
    const trips = parseCSV(tripsText);

    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth()+1).padStart(2,'0');
    const dd = String(today.getDate()).padStart(2,'0');
    const todayStr = `${yyyy}${mm}${dd}`;
    const weekday = today.getDay(); // 0=Sunday

    const activeServices = new Set();

    // calendar.txt rules
    calendar.forEach(c => {
        const start = parseInt(c.start_date,10);
        const end = parseInt(c.end_date,10);
        const dateNum = parseInt(todayStr,10);
        if (dateNum >= start && dateNum <= end) {
            if (parseInt(c[["sunday","monday","tuesday","wednesday","thursday","friday","saturday"][weekday]],10)) {
                activeServices.add(c.service_id);
            }
        }
    });

    // calendar_dates.txt overrides
    calendarDates.forEach(cd => {
        if (cd.date === todayStr) {
            if (cd.exception_type === '1') activeServices.add(cd.service_id); // added service
            if (cd.exception_type === '2') activeServices.delete(cd.service_id); // removed service
        }
    });

    // Map trip_id -> stop_id
    const tripMap = {};
    trips.forEach(t => {
        if (activeServices.has(t.service_id)) tripMap[t.trip_id] = t;
    });

    return tripMap;
}

function filterArrivals(arrivals) {
    const now = new Date();
    const past = new Date(now.getTime() - 30*60*1000); // 30 mins ago
    const future = new Date(now.getTime() + 60*60*1000); // 60 mins ahead

    return arrivals.filter(a => {
        const t = new Date();
        const [h,m,s] = a.arrival_time.split(':').map(Number);
        t.setHours(h, m, s, 0);
        return t >= past && t <= future;
    });
}

// Convert degrees to 8-point compass
function degToCompass(deg) {
    const dirs = ['N','NE','E','SE','S','SW','W','NW'];
    return dirs[Math.floor((deg + 22.5)/45) % 8];
}

async function loadStopJson(stopId) {
    try {
        const res = await fetch(`https://pub-aad94a89c9ea4f6390466b521c65d978.r2.dev/stops/${stopId}.json`);
        if (!res.ok) throw new Error(res.status);
        const data = await res.json();
        return data;
    } catch(e) {
        console.error(`Error loading stop ${stopId}`, e);
        return [];
    }
}

async function renderStops(stops, tripMap) {
    const container = document.getElementById('stopsContainer');
    container.innerHTML = '';

    for (let stop of stops.features) {
        const stopId = stop.properties.AtcoCode;
        const stopLat = parseFloat(stop.properties.Latitude);
        const stopLon = parseFloat(stop.properties.Longitude);

        const arrivalsRaw = await loadStopJson(stopId);

        // Filter to active trips and current day
        const arrivalsFiltered = arrivalsRaw.filter(a => tripMap[a.trip_id]).map(a => ({
            ...a,
            arrival_time: a.arrival_time,
            route_short: a.route_short,
            trip_headsign: a.trip_headsign
        }));

        // Filter by 30 min past / 60 min future
        const arrivalsTimeFiltered = filterArrivals(arrivalsFiltered);

        // Deduplicate
        const arrivalsDedup = [];
        const seen = new Set();
        arrivalsTimeFiltered.forEach(a => {
            const key = `${a.trip_id}|${a.arrival_time}`;
            if (!seen.has(key)) { seen.add(key); arrivalsDedup.push(a); }
        });

        // Build HTML
        const div = document.createElement('div');
        const stopNum = parseInt(stopId.slice(-6),10);
        const compass = degToCompass(Number(stop.properties.Bearing.replace(/[^\d]/g,'')) || 0);

        const distances = Math.round(stop.distance || 0);
        const mapUrl = `https://www.google.com/maps/search/?api=1&query=${stopLat},${stopLon}`;

        const arrivalsHtml = arrivalsDedup.map(a => `${a.route_short} → ${a.trip_headsign} at ${a.arrival_time}`).join('<br>') || 'No arrivals';

        div.innerHTML = `<strong>${stop.properties.SCN_English} (#${stopNum})</strong> 
            (<a href="${mapUrl}" target="_blank">${distances}m</a>, ${compass})<br>
            ${arrivalsHtml}`;

        container.appendChild(div);
    }
}

async function init() {
    try {
        const stopsText = await fetchGzText('stops.geojson.gz');
        const stops = JSON.parse(stopsText);

        const tripMap = await loadGTFSMapping();

        // Compute nearest stops here or use your existing logic
        // For demo, just take first 5 stops
        stops.features = stops.features.slice(0,5);

        await renderStops(stops, tripMap);
    } catch(e) {
        console.error(e);
    }
}

init();
