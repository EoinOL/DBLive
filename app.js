// app.js
async function loadStops() {
  // load stops.geojson.gz
  const stopsResp = await fetch("stops.geojson.gz");
  const stopsBuffer = await stopsResp.arrayBuffer();
  const stopsText = pako.ungzip(stopsBuffer, { to: "string" });
  const stopsData = JSON.parse(stopsText);

  // load GTFS files
  const [calendarResp, calendarDatesResp, tripsResp] = await Promise.all([
    fetch("calendar.txt"),
    fetch("calendar_dates.txt"),
    fetch("trips.txt.gz")
  ]);

  const calendarText = await calendarResp.text();
  const calendarDatesText = await calendarDatesResp.text();
  const tripsBuffer = await tripsResp.arrayBuffer();
  const tripsText = pako.ungzip(tripsBuffer, { to: "string" });

  // parse CSVs
  const calendar = parseCSV(calendarText);
  const calendarDates = parseCSV(calendarDatesText);
  const trips = parseCSV(tripsText);

  // figure out today's valid service_ids
  const today = new Date();
  const todayStr = today.toISOString().slice(0,10).replace(/-/g,""); // YYYYMMDD
  const dayName = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"][today.getDay()];

  // service_ids active today from calendar
  let validServiceIds = new Set(
    calendar
      .filter(row => row[dayName] === "1" && row.start_date <= todayStr && row.end_date >= todayStr)
      .map(row => row.service_id)
  );

  // apply exceptions from calendar_dates
  calendarDates.forEach(row => {
    if (row.date === todayStr) {
      if (row.exception_type === "1") validServiceIds.add(row.service_id); // added
      else if (row.exception_type === "2") validServiceIds.delete(row.service_id); // removed
    }
  });

  // map trip_id -> service_id for quick lookup
  const tripServiceMap = {};
  trips.forEach(row => { tripServiceMap[row.trip_id] = row.service_id; });

  return { stopsData, validServiceIds, tripServiceMap };
}

function parseCSV(csvText) {
  const lines = csvText.split("\n");
  const headers = lines.shift().split(",");
  return lines.map(line => {
    const values = line.split(",");
    const obj = {};
    headers.forEach((h,i) => { obj[h] = values[i]; });
    return obj;
  });
}

function bearingToCompass(deg) {
  const directions = ["N","NE","E","SE","S","SW","W","NW"];
  return directions[Math.round(deg / 45) % 8];
}

// example function to render stops
async function renderStops({stopsData, validServiceIds, tripServiceMap}, userLat, userLon) {
  const stopsContainer = document.getElementById("stops");
  stopsContainer.innerHTML = "";

  // sort stops by distance
  const stops = stopsData.features.map(f => {
    const lat = parseFloat(f.properties.Latitude);
    const lon = parseFloat(f.properties.Longitude);
    const dx = lat - userLat;
    const dy = lon - userLon;
    const dist = Math.sqrt(dx*dx + dy*dy)*111000; // rough meters
    const bearing = Math.atan2(dy,dx)*180/Math.PI;
    return {props: f.properties, lat, lon, dist, bearing};
  }).sort((a,b)=>a.dist-b.dist).slice(0,5); // nearest 5

  for (const stop of stops) {
    const stopId = stop.props.AtcoCode;
    let arrivals = [];
    try {
      const resp = await fetch(`https://pub-aad94a89c9ea4f6390466b521c65d978.r2.dev/stops/${stopId}.json`);
      const data = await resp.json();
      const now = new Date();
      arrivals = data.filter(a => {
        const tripService = tripServiceMap[a.trip_id];
        if (!tripService || !validServiceIds.has(tripService)) return false; // skip if not today
        const arrTimeParts = a.arrival_time.split(":");
        const arrDate = new Date(now);
        arrDate.setHours(parseInt(arrTimeParts[0]),parseInt(arrTimeParts[1]),parseInt(arrTimeParts[2]));
        const diff = (arrDate - now)/60000;
        return diff >= -30 && diff <= 60; // previous 30 mins to next 60 mins
      });

      // remove duplicates
      arrivals = arrivals.filter((v,i,a)=>i===a.findIndex(t=>
        t.trip_id === v.trip_id && t.arrival_time === v.arrival_time
      ));

    } catch(e) {
      console.warn("Error loading stop", stopId, e);
    }

    const stopNumber = parseInt(stopId.slice(-6),10);
    const compass = bearingToCompass(stop.bearing);
    const distanceLink = `https://www.google.com/maps/search/?api=1&query=${stop.lat},${stop.lon}`;

    const html = `
      <div class="stop">
        <h3>${stopNumber} → ${stop.props.SCN_English}</h3>
        <p><a href="${distanceLink}" target="_blank">${Math.round(stop.dist)} m</a>, ${compass}</p>
        <ul>
          ${arrivals.map(a=>`<li>${a.route_short} → ${a.trip_headsign} at ${a.arrival_time}</li>`).join("")}
        </ul>
      </div>
    `;
    stopsContainer.innerHTML += html;
  }
}

// get user location and render stops
navigator.geolocation.getCurrentPosition(async pos => {
  const {stopsData, validServiceIds, tripServiceMap} = await loadStops();
  renderStops({stopsData, validServiceIds, tripServiceMap}, pos.coords.latitude, pos.coords.longitude);
});
