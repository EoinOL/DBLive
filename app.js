const stopsGzUrl = 'stops.geojson.gz'; // your compressed stops file
const r2BaseUrl = 'https://pub-aad94a89c9ea4f6390466b521c65d978.r2.dev/stops/'; // base URL of stop JSONs
const maxNearestStops = 5;

let stopsData = [];

// Utility: Haversine distance
function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000; // meters
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat/2)**2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
              Math.sin(dLon/2)**2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

// Utility: simple bearing approximation
function getBearing(lat1, lon1, lat2, lon2) {
    const toDeg = rad => rad * 180 / Math.PI;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const y = Math.sin(dLon) * Math.cos(lat2 * Math.PI/180);
    const x = Math.cos(lat1 * Math.PI/180)*Math.sin(lat2 * Math.PI/180) -
              Math.sin(lat1 * Math.PI/180)*Math.cos(lat2 * Math.PI/180)*Math.cos(dLon);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// Load stops.geojson.gz
async function loadStops() {
    const response = await fetch(stopsGzUrl);
    const buffer = await response.arrayBuffer();
    const decompressed = pako.ungzip(new Uint8Array(buffer), { to: 'string' });
    const geojson = JSON.parse(decompressed);
    stopsData = geojson.features.map(f => ({
        id: f.properties.AtcoCode,
        name: f.properties.SCN_English,
        lat: parseFloat(f.properties.Latitude),
        lon: parseFloat(f.properties.Longitude)
    }));
}

// Get nearest stops
function getNearestStops(userLat, userLon) {
    return stopsData
        .map(s => ({
            ...s,
            distance: getDistance(userLat, userLon, s.lat, s.lon),
            bearing: getBearing(userLat, userLon, s.lat, s.lon)
        }))
        .sort((a,b) => a.distance - b.distance)
        .slice(0, maxNearestStops);
}

// Load stop JSON from R2
async function loadStopJson(stop) {
    const url = r2BaseUrl + stop.id + '.json';
    try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error('Stop JSON not found');
        const arrivals = await resp.json();
        return arrivals;
    } catch (e) {
        return []; // gracefully handle missing stop data
    }
}

// Render stops and arrivals
async function renderStops(stops) {
    const container = document.getElementById('stops-container');
    container.innerHTML = '';
    for (let stop of stops) {
        const div = document.createElement('div');
        div.className = 'stop';
        const heading = document.createElement('h2');
        heading.textContent = `${stop.name} (${Math.round(stop.distance)} m, ${Math.round(stop.bearing)}°)`;
        div.appendChild(heading);

        const arrivals = await loadStopJson(stop);
        if (arrivals.length === 0) {
            const p = document.createElement('p');
            p.textContent = 'No expected arrivals';
            div.appendChild(p);
        } else {
            const ul = document.createElement('ul');
            for (let arr of arrivals) {
                const li = document.createElement('li');
                li.className = 'arrival';
                li.textContent = `${arr.route_short} → ${arr.trip_headsign} at ${arr.arrival_time}`;
                ul.appendChild(li);
            }
            div.appendChild(ul);
        }

        container.appendChild(div);
    }
}

// Main
async function init() {
    await loadStops();

    if (!navigator.geolocation) {
        document.getElementById('stops-container').textContent = 'Geolocation not available';
        return;
    }

    navigator.geolocation.getCurrentPosition(async pos => {
        const userLat = pos.coords.latitude;
        const userLon = pos.coords.longitude;
        const nearest = getNearestStops(userLat, userLon);
        renderStops(nearest);
    }, err => {
        document.getElementById('stops-container').textContent = 'Location access denied';
    });
}

init();
