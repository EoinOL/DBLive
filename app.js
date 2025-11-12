async function loadStops() {
  const res = await fetch('stops.geojson.gz');
  const buf = await res.arrayBuffer();
  const text = pako.ungzip(new Uint8Array(buf), { to: 'string' });
  const geojson = JSON.parse(text);
  console.log(`Loaded ${geojson.features.length} stops`);
  return geojson.features;
}

// Haversine formula (distance in meters)
function distance(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // Earth radius in meters
  const toRad = (x) => (x * Math.PI) / 180;
  const φ1 = toRad(lat1), φ2 = toRad(lat2);
  const Δφ = toRad(lat2 - lat1);
  const Δλ = toRad(lon2 - lon1);
  const a = Math.sin(Δφ / 2) ** 2 +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function main() {
  const coordsDiv = document.getElementById('coords');
  const stopsDiv = document.getElementById('stops');
  const stops = await loadStops();

  if (!navigator.geolocation) {
    coordsDiv.textContent = 'Geolocation not supported.';
    return;
  }

  coordsDiv.textContent = 'Locating…';

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude, accuracy } = pos.coords;
      coordsDiv.textContent = `Lat: ${latitude.toFixed(6)}, Lon: ${longitude.toFixed(6)} (±${accuracy.toFixed(1)}m)`;

      // Compute distance to each stop
      const distances = stops.map((f) => {
        const [lon, lat] = f.geometry.coordinates;
        return {
          id: f.properties.stopid || f.properties.stop_id || '?',
          name: f.properties.full_name || f.properties.name || 'Unknown',
          distance: distance(latitude, longitude, lat, lon),
          lat, lon
        };
      });

      // Sort by distance
      distances.sort((a, b) => a.distance - b.distance);
      const nearest = distances.slice(0, 5);

      stopsDiv.innerHTML = nearest.map(s => `
        <div class="stop">
          <strong>${s.name}</strong><br>
          Stop No: ${s.id}<br>
          Distance: ${s.distance.toFixed(0)} m<br>
          (${s.lat.toFixed(6)}, ${s.lon.toFixed(6)})
        </div>
      `).join('');
    },
    (err) => {
      coordsDiv.textContent = `Error: ${err.message}`;
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
}

main();
