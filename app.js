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

  return geojson;
}

async function init() {
  document.body.innerHTML = "<p>Locating...</p>";
  navigator.geolocation.getCurrentPosition(async (pos) => {
    const lat = pos.coords.latitude;
    const lon = pos.coords.longitude;
    const acc = pos.coords.accuracy;
    document.body.innerHTML = `<p>Location: ${lat.toFixed(6)}, ${lon.toFixed(6)} (±${acc.toFixed(1)} m)</p><p>Loading bus stops...</p>`;

    try {
      const geojson = await loadStops();
      document.body.innerHTML += `<p>Loaded ${geojson.features.length} stops.</p>`;
    } catch (err) {
      document.body.innerHTML += `<p style="color:red;">Error: ${err.message}</p>`;
      console.error(err);
    }
  });
}

init();
