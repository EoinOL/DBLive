// Load and decompress the GeoJSON stops file
async function loadStops() {
  console.log("Fetching stops...");
  const response = await fetch("stops.geojson.gz");
  console.log("Response status:", response.status);

  const arrayBuffer = await response.arrayBuffer();
  console.log("Got array buffer:", arrayBuffer.byteLength);

  const decompressed = pako.ungzip(new Uint8Array(arrayBuffer), { to: "string" });
  console.log("Decompressed length:", decompressed.length);

  const geojson = JSON.parse(decompressed);
  console.log("Parsed features:", geojson.features.length);

  return geojson.features;
}

// Haversine formula: distance in meters between two lat/lon points
function distance(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // Earth radius in meters
  const toRad = (x) => (x * Math.PI) / 180;
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δφ = toRad(lat2 - lat1);
  const Δλ = toRad(lon2 - lon1);

  const a =
    Math.sin(Δφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Compute initial bearing from point A to B in degrees
function bearing(lat1, lon1, lat2, lon2) {
  const toRad = (x) => (x * Math.PI) / 180;
  const toDeg = (x) => (x * 180) / Math.PI;

  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);

  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);

  let θ = toDeg(Math.atan2(y, x));
  return (θ + 360) % 360; // normalize to 0–360
}

// Convert bearing in degrees to 8-point compass
function compassDirection(deg) {
  const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const index = Math.round(deg / 45) % 8;
  return directions[index];
}

// Clean stop code: last 6 digits, no leading zeros
function cleanStopCode(code) {
  if (!code) return "?";
  const last6 = code.slice(-6);
  return String(Number(last6));
}

// Format ISO 8601 time to HH:MM
function formatTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// Fetch real-time arrivals from Cloudflare Worker
async function getArrivals(atco) {
  const proxyUrl = `https://falling-firefly-fd90.eoinol.workers.dev?atco=${atco}`;
  const resp = await fetch(proxyUrl);
  if (!resp.ok) throw new Error("Failed to fetch arrivals");
  return await resp.json();
}

async function main() {
  const coordsDiv = document.getElementById("coords");
  const stopsDiv = document.getElementById("stops");

  // Load stops
  const stops = await loadStops();

  if (!navigator.geolocation) {
    coordsDiv.textContent = "Geolocation not supported.";
    return;
  }

  coordsDiv.textContent = "Locating…";

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { latitude, longitude, accuracy } = pos.coords;
      coordsDiv.textContent = `Lat: ${latitude.toFixed(6)}, Lon: ${longitude.toFixed(
        6
      )} (±${accuracy.toFixed(1)} m)`;

      // Map stops with proper property names
      const distances = stops
        .filter(
          (f) =>
            f.properties &&
            f.properties.AtcoCode &&
            f.properties.SCN_English &&
            f.properties.Latitude &&
            f.properties.Longitude
        )
        .map((f) => {
          const lat = Number(f.properties.Latitude);
          const lon = Number(f.properties.Longitude);

          const stopBearing = bearing(latitude, longitude, lat, lon);
          const direction = compassDirection(stopBearing);

          return {
            id: f.properties.AtcoCode, // keep full AtcoCode for Worker
            cleanId: cleanStopCode(f.properties.AtcoCode),
            name: f.properties.SCN_English || "Unknown",
            distance: distance(latitude, longitude, lat, lon),
            direction,
            lat,
            lon,
          };
        });

      // Sort by distance and take the nearest 5 stops
      distances.sort((a, b) => a.distance - b.distance);
      const nearest = distances.slice(0, 5);

      // Display nearest stops
      stopsDiv.innerHTML = nearest
        .map(
          (s) => `
          <div class="stop">
            <strong>${s.name}</strong><br>
            Stop No: ${s.cleanId}<br>
            <a href="https://www.google.com/maps/search/?api=1&query=${s.lat},${s.lon}" target="_blank">
              ${s.distance.toFixed(0)} m (${s.direction})
            </a>
            <div class="arrivals" id="arrivals-${s.cleanId}">Loading arrivals...</div>
          </div>
        `
        )
        .join("");

      // Fetch real-time arrivals for each stop
      nearest.forEach(async (s) => {
        const arrivalsDiv = document.getElementById(`arrivals-${s.cleanId}`);
        try {
          const data = await getArrivals(s.id); // full AtcoCode
          if (!data || !data.arrivals || data.arrivals.length === 0) {
            arrivalsDiv.textContent = "No upcoming arrivals";
            return;
          }
          arrivalsDiv.innerHTML = data.arrivals
            .map(
              (a) =>
                `${a.Line} → ${a.DestinationName || a.Destination} (${formatTime(
                  a.ExpectedArrival
                )})`
            )
            .join("<br>");
        } catch (err) {
          arrivalsDiv.textContent = "Error loading arrivals";
        }
      });
    },
    (err) => {
      coordsDiv.textContent = `Error: ${err.message}`;
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
}

main();
