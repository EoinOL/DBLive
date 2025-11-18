// Convert degrees to 8 compass points
function degreesToCompass(deg) {
    const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    return directions[Math.round(((deg % 360) / 45)) % 8];
}

// Load stops from compressed GeoJSON
async function loadStops() {
    try {
        const response = await fetch('stops.geojson.gz');
        const compressed = new Uint8Array(await response.arrayBuffer());
        const decompressed = pako.ungzip(compressed, { to: 'string' });
        const geojson = JSON.parse(decompressed);
        return geojson.features;
    } catch (err) {
        console.error('Error loading stops:', err);
        return [];
    }
}

// Calculate distance and bearing (in degrees) between two lat/lon points
function getDistanceAndBearing(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // meters
    const φ1 = lat1 * Math.PI/180;
    const φ2 = lat2 * Math.PI/180;
    const Δφ = (lat2-lat1) * Math.PI/180;
    const Δλ = (lon2-lon1) * Math.PI/180;

    const a = Math.sin(Δφ/2)*Math.sin(Δφ/2) +
              Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)*Math.sin(Δλ/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    const d = R * c;

    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1)*Math.sin(φ2) -
              Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ);
    const θ = Math.atan2(y, x) * 180/Math.PI; // degrees

    return { distance: d, bearing: (θ + 360) % 360 };
}

// Find nearest stops to user location
async function findNearestStops() {
    if (!navigator.geolocation) {
        document.getElementById('stops-container').innerText = 'Geolocation not supported.';
        return;
    }

    const stops = await loadStops();

    navigator.geolocation.getCurrentPosition(pos => {
        const userLat = pos.coords.latitude;
        const userLon = pos.coords.longitude;

        stops.forEach(stop => {
            const lat = parseFloat(stop.properties.Latitude);
            const lon = parseFloat(stop.properties.Longitude);
            const { distance, bearing } = getDistanceAndBearing(userLat, userLon, lat, lon);
            stop.distance = distance;
            stop.bearing = bearing;
        });

        stops.sort((a,b) => a.distance - b.distance);
        renderStops(stops.slice(0, 5));
    });
}

// Render nearest stops
async function renderStops(nearestStops) {
    const container = document.getElementById("stops-container");
    container.innerHTML = "";

    for (const stop of nearestStops) {
        // Stop number: last 6 digits of AtcoCode, remove leading zeroes
        let stopNumber = stop.properties.AtcoCode.slice(-6).replace(/^0+/, "");

        // Compass bearing (8 points)
        let compass = degreesToCompass(stop.bearing);

        // Google Maps link
        let mapLink = `https://www.google.com/maps/search/?api=1&query=${stop.properties.Latitude},${stop.properties.Longitude}`;

        // Fetch arrivals JSON
        let arrivals = [];
        try {
            const resp = await fetch(`https://pub-aad94a89c9ea4f6390466b521c65d978.r2.dev/stops/${stop.properties.AtcoCode}.json`);
            if (resp.ok) arrivals = await resp.json();
        } catch (err) {
            console.warn('Error loading stop:', stop.properties.AtcoCode, err);
        }

        const arrivalsHTML = arrivals.length > 0
            ? arrivals.map(a => `${a.route_short} → ${a.trip_headsign} at ${a.arrival_time}`).join('<br>')
            : 'No arrivals data';

        container.innerHTML += `
            <div class="stop">
                <strong>${stop.properties.SCN_English}</strong> (#${stopNumber})<br>
                <a href="${mapLink}" target="_blank">${Math.round(stop.distance)} m</a>, ${compass}<br>
                ${arrivalsHTML}
            </div>
        `;
    }
}

// Start
findNearestStops();
