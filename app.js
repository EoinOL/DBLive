// URLs
const STOPS_URL = 'https://eoinol.github.io/stops.geojson.gz';
const STOP_JSON_BASE = 'https://pub-aad94a89c9ea4f6390466b521c65d978.r2.dev/stops/';

// Utility: Haversine distance in meters
function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3;
    const φ1 = lat1 * Math.PI/180, φ2 = lat2 * Math.PI/180;
    const Δφ = (lat2-lat1) * Math.PI/180;
    const Δλ = (lon2-lon1) * Math.PI/180;
    const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
    const c = 2*Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R*c;
}

// Bearing in 8 compass points
function getCompassBearing(lat1, lon1, lat2, lon2) {
    const θ = Math.atan2(
        Math.sin((lon2-lon1)*Math.PI/180)*Math.cos(lat2*Math.PI/180),
        Math.cos(lat1*Math.PI/180)*Math.sin(lat2*Math.PI/180) -
        Math.sin(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.cos((lon2-lon1)*Math.PI/180)
    ) * 180/Math.PI;
    const deg = (θ + 360) % 360;
    const compass = ['N','NE','E','SE','S','SW','W','NW'];
    return compass[Math.round(deg/45)%8];
}

// Get user location
async function getLocation() {
    return new Promise((resolve, reject) => {
        if (!navigator.geolocation) return reject('Geolocation not supported');
        navigator.geolocation.getCurrentPosition(
            pos => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
            err => reject(err)
        );
    });
}

// Load and decompress stops.geojson.gz
async function loadStops() {
    const res = await fetch(STOPS_URL);
    const buf = await res.arrayBuffer();
    const decompressed = pako.ungzip(new Uint8Array(buf), { to: 'string' });
    return JSON.parse(decompressed);
}

// Load individual stop JSON
async function loadStopJson(atco) {
    try {
        const res = await fetch(`${STOP_JSON_BASE}${atco}.json`);
        if (!res.ok) throw new Error(res.status);
        return await res.json();
    } catch (err) {
        console.warn(`Error loading stop ${atco}:`, err);
        return [];
    }
}

// Render stops with distances and arrivals
async function renderStops(userPos) {
    const statusEl = document.getElementById('status');
    const container = document.getElementById('stopsContainer');

    statusEl.textContent = 'Loading stops…';
    const stopsGeo = await loadStops();
    const stopsWithDist = stopsGeo.features.map(f => {
        const lat = parseFloat(f.properties.Latitude);
        const lon = parseFloat(f.properties.Longitude);
        const dist = getDistance(userPos.lat, userPos.lon, lat, lon);
        const bearing = getCompassBearing(userPos.lat, userPos.lon, lat, lon);
        return { ...f.properties, lat, lon, dist, bearing };
    });

    stopsWithDist.sort((a,b) => a.dist - b.dist);
    const nearest = stopsWithDist.slice(0, 5);

    container.innerHTML = '';
    for (const stop of nearest) {
        const stopNumber = parseInt(stop.AtcoCode.slice(-6), 10);
        const gmapsUrl = `https://www.google.com/maps/search/?api=1&query=${stop.Latitude},${stop.Longitude}`;
        const div = document.createElement('div');
        div.className = 'stop';
        div.innerHTML = `<h2>${stop.SCN_English} (#${stopNumber}) <a href="${gmapsUrl}" target="_blank">(${Math.round(stop.dist)} m, ${stop.bearing})</a></h2><div class="arrivals">Loading…</div>`;
        container.appendChild(div);

        const arrivals = await loadStopJson(stop.AtcoCode);
        const now = new Date();
        const filtered = arrivals.filter(a => {
            const t = new Date();
            const parts = a.arrival_time.split(':');
            t.setHours(parseInt(parts[0]), parseInt(parts[1]), parseInt(parts[2]), 0);
            const deltaMin = (t - now)/60000;
            return deltaMin >= -30 && deltaMin <= 60;
        });
        // Remove duplicates by trip_id + arrival_time
        const unique = Array.from(new Map(filtered.map(a => [a.trip_id+'_'+a.arrival_time, a])).values());
        const arrivalsDiv = div.querySelector('.arrivals');
        if (unique.length === 0) arrivalsDiv.textContent = 'No arrivals soon';
        else arrivalsDiv.innerHTML = unique.map(a => `${a.route_short} → ${a.trip_headsign} at ${a.arrival_time}`).join('<br>');
    }

    statusEl.textContent = '';
}

// Init
async function init() {
    const statusEl = document.getElementById('status');
    try {
        const userPos = await getLocation();
        console.log('User coordinates:', userPos);
        await renderStops(userPos);
    } catch(err) {
        console.error('Could not get location:', err);
        statusEl.textContent = 'Cannot determine your location. Please allow location access.';
    }
}

init();
