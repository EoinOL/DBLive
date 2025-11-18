const R2_BASE = "https://pub-aad94a89c9ea4f6390466b521c65d978.r2.dev/stops";
const GEOJSON_URL = "stops.geojson.gz"; // must be in your GitHub repo

// Gunzip helper
async function gunzipFetch(url) {
    const resp = await fetch(url);
    const blob = await resp.blob();
    const ds = new DecompressionStream("gzip");
    const decompressed = blob.stream().pipeThrough(ds);
    const text = await new Response(decompressed).text();
    return JSON.parse(text);
}

// Haversine distance (meters)
function distance(lat1, lon1, lat2, lon2) {
    const R = 6371e3;
    const toRad = deg => deg * Math.PI / 180;
    const φ1 = toRad(lat1);
    const φ2 = toRad(lat2);
    const Δφ = toRad(lat2 - lat1);
    const Δλ = toRad(lon2 - lon1);

    const a = Math.sin(Δφ/2) ** 2 +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ/2) ** 2;

    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Bearing (compass-ish)
function bearing(lat1, lon1, lat2, lon2) {
    const toRad = d => d * Math.PI / 180;
    const toDeg = r => r * 180 / Math.PI;

    const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
    const x = Math.cos(toRad(lat1))*Math.cos(toRad(lat2)) *
              Math.cos(toRad(lon2 - lon1)) -
              Math.sin(toRad(lat1)) * Math.sin(toRad(lat2));
    const brng = (toDeg(Math.atan2(y, x)) + 360) % 360;

    if (brng < 22.5) return "N";
    if (brng < 67.5) return "NE";
    if (brng < 112.5) return "E";
    if (brng < 157.5) return "SE";
    if (brng < 202.5) return "S";
    if (brng < 247.5) return "SW";
    if (brng < 292.5) return "W";
    return "NW";
}

async function main() {
    document.getElementById("status").innerText = "Loading stop database…";

    // Load stops data
    const geojson = await gunzipFetch(GEOJSON_URL);
    const stops = geojson.features;

    // Get user location
    document.getElementById("status").innerText = "Getting location…";

    navigator.geolocation.getCurrentPosition(async pos => {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;

        document.getElementById("status").innerText = "Finding nearest stops…";

        // Distance to each stop
        stops.forEach(s => {
            const [lon2, lat2] = s.geometry.coordinates;
            s.properties.distance = distance(lat, lon, lat2, lon2);
            s.properties.bearing = bearing(lat, lon, lat2, lon2);
        });

        // Sort and take nearest 5
        const nearest = stops
            .sort((a,b) => a.properties.distance - b.properties.distance)
            .slice(0, 5);

        // Display
        const results = document.getElementById("results");
        results.innerHTML = "";

        for (const stop of nearest) {
            const id = stop.properties.stop_id;
            const name = stop.properties.stop_name;
            const dist = Math.round(stop.properties.distance);
            const dir = stop.properties.bearing;

            const stopCard = document.createElement("div");
            stopCard.className = "stop-card";

            stopCard.innerHTML = `
                <div class="stop-title">${name} (${id})</div>
                <div>${dist}m ${dir}</div>
                <div class="arrival-list" id="arr-${id}">Loading…</div>
            `;

            results.appendChild(stopCard);

            // Fetch expected times
            try {
                const url = `${R2_BASE}/${id}.json`;
                const resp = await fetch(url);

                if (!resp.ok) {
                    document.getElementById(`arr-${id}`).innerText = "No data";
                    continue;
                }

                const arrivals = await resp.json();

                const listDiv = document.getElementById(`arr-${id}`);
                listDiv.innerHTML = arrivals.map(a =>
                    `<div><b>${a.route_short}</b> → ${a.trip_headsign} @ ${a.arrival_time}</div>`
                ).join("");

            } catch {
                document.getElementById(`arr-${id}`).innerText = "Error loading stop";
            }
        }

    }, err => {
        document.getElementById("status").innerText = "Location error.";
    });
}

main();
