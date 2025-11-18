(async () => {
  const STOPS_URL = 'stops.geojson.gz';
  const R2_BASE_URL = 'https://pub-aad94a89c9ea4f6390466b521c65d978.r2.dev/stops/';

  // Utility: fetch and decompress stops
  async function loadStops() {
    const res = await fetch(STOPS_URL);
    const buffer = await res.arrayBuffer();
    const decompressed = pako.ungzip(new Uint8Array(buffer), { to: 'string' });
    return JSON.parse(decompressed).features;
  }

  // Utility: Haversine distance
  function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const φ1 = lat1 * Math.PI/180;
    const φ2 = lat2 * Math.PI/180;
    const Δφ = (lat2-lat1) * Math.PI/180;
    const Δλ = (lon2-lon1) * Math.PI/180;
    const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  }

  // Utility: simple bearing calculation
  function getBearing(lat1, lon1, lat2, lon2) {
    const φ1 = lat1*Math.PI/180, φ2 = lat2*Math.PI/180;
    const Δλ = (lon2-lon1)*Math.PI/180;
    const y = Math.sin(Δλ)*Math.cos(φ2);
    const x = Math.cos(φ1)*Math.sin(φ2)-Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ);
    const θ = Math.atan2(y,x);
    const deg = (θ*180/Math.PI+360)%360;
    const directions = ["N","NE","E","SE","S","SW","W","NW"];
    return directions[Math.round(deg/45)%8];
  }

  // Utility: fetch stop arrivals
  async function fetchStopArrivals(atcoCode) {
    const url = `${R2_BASE_URL}${atcoCode}.json`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('No static schedule available');
      return await res.json();
    } catch (err) {
      return null;
    }
  }

  const stopsDiv = document.getElementById('stops');
  let userLat = null, userLon = null;

  function showStops(nearestStops) {
    stopsDiv.innerHTML = '';
    nearestStops.forEach(async stop => {
      const div = document.createElement('div');
      div.className = 'stop';
      const name = stop.properties.SCN_English;
      const atco = stop.properties.AtcoCode;
      const distance = Math.round(stop.distance);
      const bearing = stop.bearing;

      div.innerHTML = `<h2>${name} (${distance}m ${bearing})</h2><div class="arrivals">Loading…</div>`;
      stopsDiv.appendChild(div);

      const arrivalsDiv = div.querySelector('.arrivals');
      const arrivals = await fetchStopArrivals(atco);
      if (!arrivals) {
        arrivalsDiv.textContent = 'No static schedule available';
        return;
      }

      arrivalsDiv.innerHTML = arrivals
        .sort((a,b)=> a.arrival_time.localeCompare(b.arrival_time))
        .map(a=> `${a.route_short} → ${a.trip_headsign} (${a.arrival_time})`)
        .join('<br>');
    });
  }

  const features = await loadStops();

  // Get location
  navigator.geolocation.getCurrentPosition(pos=>{
    userLat = pos.coords.latitude;
    userLon = pos.coords.longitude;

    const nearestStops = features
      .map(f=>({
        ...f,
        distance: getDistance(userLat,userLon,+f.properties.Latitude,+f.properties.Longitude),
        bearing: getBearing(userLat,userLon,+f.properties.Latitude,+f.properties.Longitude)
      }))
      .sort((a,b)=>a.distance-b.distance)
      .slice(0,5);

    showStops(nearestStops);
  }, err=>{
    stopsDiv.textContent = 'Unable to get location';
  });
})();
