// app.js

let stopsData = [];
let tripsMap = {};
let activeServices = new Set();

const STOP_RADIUS = 5; // number of nearest stops to show

async function loadCSV(url) {
    const resp = await fetch(url);
    const text = await resp.text();
    const lines = text.split('\n').filter(l => l.trim());
    const headers = lines[0].split(',');
    return lines.slice(1).map(line => {
        const cols = line.split(',');
        let obj = {};
        headers.forEach((h, i) => obj[h.trim()] = cols[i]?.trim());
        return obj;
    });
}

function compassFromDegrees(deg) {
    const points = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    return points[Math.round(((deg % 360) / 45)) % 8];
}

function distance(lat1, lon1, lat2, lon2) {
    // Haversine formula
    const R = 6371000;
    const φ1 = lat1 * Math.PI/180, φ2 = lat2 * Math.PI/180;
    const Δφ = (lat2-lat1) * Math.PI/180;
    const Δλ = (lon2-lon1) * Math.PI/180;
    const a = Math.sin(Δφ/2)*Math.sin(Δφ/2) +
              Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)*Math.sin(Δλ/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

function bearing(lat1, lon1, lat2, lon2) {
    const φ1 = lat1 * Math.PI/180, φ2 = lat2 * Math.PI/180;
    const λ1 = lon1 * Math.PI/180, λ2 = lon2 * Math.PI/180;
    const y = Math.sin(λ2-λ1) * Math.cos(φ2);
    const x = Math.cos(φ1)*Math.sin(φ2) -
              Math.sin(φ1)*Math.cos(φ2)*Math.cos(λ2-λ1);
    let θ = Math.atan2(y,x) * 180/Math.PI;
    return (θ+360)%360;
}

async function loadStops() {
    // stops.geojson.gz is compressed, load via pako
    const resp = await fetch('stops.geojson.gz');
    const buf = await resp.arrayBuffer();
    const decompressed = pako.ungzip(new Uint8Array(buf), { to: 'string' });
    const geojson = JSON.parse(decompressed);
    stopsData = geojson.features.map(f => ({
        AtcoCode: f.properties.AtcoCode,
        name: f.properties.SCN_English,
        lat: parseFloat(f.properties.Latitude),
        lon: parseFloat(f.properties.Longitude)
    }));
}

async function loadGTFSMapping() {
    // trips.txt -> trip_id => service_id
    const trips = await loadCSV('trips.txt');
    trips.forEach(t => tripsMap[t.trip_id] = t.service_id);

    // Determine active service_ids for today
    const today = new Date();
    const dayNames = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
    const todayStr = today.toISOString().slice(0,10).replace(/-/g,''); // YYYYMMDD

    const calendar = await loadCSV('calendar.txt');
    calendar.forEach(c => {
        if(c.start_date && c.end_date &&
           todayStr >= c.start_date && todayStr <= c.end_date &&
           c[dayNames[today.getDay()]] === '1') {
            activeServices.add(c.service_id);
        }
    });

    const calendarDates = await loadCSV('calendar_dates.txt');
    calendarDates.forEach(cd => {
        if(cd.date === todayStr && cd.exception_type === '1') {
            activeServices.add(cd.service_id);
        } else if(cd.date === todayStr && cd.exception_type === '2') {
            activeServices.delete(cd.service_id);
        }
    });
}

async function loadStopJson(atco) {
    try {
        const resp = await fetch(`https://pub-aad94a89c9ea4f6390466b521c65d978.r2.dev/stops/${atco}.json`);
        if(!resp.ok) throw new Error(resp.status);
        return await resp.json();
    } catch(e) {
        console.warn('Error loading stop', atco, e);
        return [];
    }
}

async function renderStops() {
    const userLoc = await new Promise((resolve,reject)=>{
        navigator.geolocation.getCurrentPosition(p=>resolve(p.coords),e=>reject(e));
    });

    stopsData.forEach(s=>{
        s.dist = distance(userLoc.latitude, userLoc.longitude, s.lat, s.lon);
        s.bear = compassFromDegrees(bearing(userLoc.latitude, userLoc.longitude, s.lat, s.lon));
    });

    const nearest = stopsData.sort((a,b)=>a.dist-b.dist).slice(0, STOP_RADIUS);

    const container = document.getElementById('stops');
    container.innerHTML = '';

    for(const stop of nearest) {
        const arrivals = await loadStopJson(stop.AtcoCode);

        const now = new Date();
        const windowStart = new Date(now.getTime() - 30*60*1000);
        const windowEnd = new Date(now.getTime() + 60*60*1000);

        // Filter by time window AND active service
        const filtered = arrivals.filter(a=>{
            const service_id = tripsMap[a.trip_id];
            if(!service_id || !activeServices.has(service_id)) return false;
            const [h,m,s] = a.arrival_time.split(':').map(Number);
            const arrDate = new Date(now);
            arrDate.setHours(h, m, s, 0);
            return arrDate >= windowStart && arrDate <= windowEnd;
        });

        // Deduplicate by trip_id
        const deduped = Array.from(new Map(filtered.map(a=>[a.trip_id,a])).values());

        const stopNumber = parseInt(stop.AtcoCode.slice(-6),10);
        const mapUrl = `https://www.google.com/maps/search/?api=1&query=${stop.lat},${stop.lon}`;

        const ul = document.createElement('ul');
        ul.innerHTML = `<strong>${stopNumber} - ${stop.name}</strong> (${Math.round(stop.dist)} m, <a href="${mapUrl}" target="_blank">${stop.bear}</a>)`;
        deduped.forEach(a=>{
            const li = document.createElement('li');
            li.textContent = `${a.route_short} → ${a.trip_headsign} at ${a.arrival_time}`;
            ul.appendChild(li);
        });

        container.appendChild(ul);
    }
}

async function init() {
    await loadStops();
    await loadGTFSMapping();
    await renderStops();
}

init().catch(console.error);
