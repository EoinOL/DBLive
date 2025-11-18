// === CONFIG ===
const STOP_JSON_BASE = 'https://pub-aad94a89c9ea4f6390466b521c65d978.r2.dev/stops/';
const STOPS_GEOJSON_GZ = 'stops.geojson.gz';
const TRIPS_TXT_GZ = 'trips.txt.gz';
const CALENDAR_TXT = 'calendar.txt';
const CALENDAR_DATES_TXT = 'calendar_dates.txt';
const MAX_NEARBY_STOPS = 5;
const TIME_WINDOW_PAST_MIN = 30;
const TIME_WINDOW_FUTURE_MIN = 60;

// === GLOBALS ===
let stops = [];
let tripsMap = {};
let serviceMap = {};
let exceptionsMap = {};

// === UTILS ===
function degToCompass(deg) {
    const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return directions[Math.round(((deg % 360) / 45)) % 8];
}

function distance(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = deg => deg * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function bearing(lat1, lon1, lat2, lon2) {
    const toRad = deg => deg * Math.PI / 180;
    const toDeg = rad => rad * 180 / Math.PI;
    const y = Math.sin(toRad(lon2-lon1)) * Math.cos(toRad(lat2));
    const x = Math.cos(toRad(lat1))*Math.sin(toRad(lat2)) - Math.sin(toRad(lat1))*Math.cos(toRad(lat2))*Math.cos(toRad(lon2-lon1));
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// Simple CSV loader
async function loadCSV(url) {
    const res = await fetch(url);
    const txt = await res.text();
    const lines = txt.trim().split('\n');
    const headers = lines.shift().split(',');
    return lines.map(l => {
        const vals = l.split(',');
        let obj = {};
        headers.forEach((h,i)=> obj[h] = vals[i]);
        return obj;
    });
}

// Load gzipped CSV
async function loadGzCSV(url) {
    const res = await fetch(url);
    const buf = await res.arrayBuffer();
    const decompressed = pako.ungzip(new Uint8Array(buf), { to: 'string' });
    const lines = decompressed.trim().split('\n');
    const headers = lines.shift().split(',');
    return lines.map(l => {
        const vals = l.split(',');
        let obj = {};
        headers.forEach((h,i)=> obj[h] = vals[i]);
        return obj;
    });
}

// === DATA LOADING ===
async function loadStops() {
    const res = await fetch(STOPS_GEOJSON_GZ);
    const buf = await res.arrayBuffer();
    const decompressed = pako.ungzip(new Uint8Array(buf), { to: 'string' });
    const geo = JSON.parse(decompressed.replace(/^var stops = /,'').replace(/;$/,''));
    stops = geo.features.map(f=>{
        const p = f.properties;
        return {
            atco: p.AtcoCode,
            lat: parseFloat(p.Latitude),
            lon: parseFloat(p.Longitude),
            name: p.SCN_English
        };
    });
}

async function loadGTFSMapping() {
    // trips -> service_id
    const trips = await loadGzCSV(TRIPS_TXT_GZ);
    tripsMap = {};
    trips.forEach(t=>tripsMap[t.trip_id] = t.service_id);

    // calendar -> weekday schedule
    const calendar = await loadCSV(CALENDAR_TXT);
    calendar.forEach(c=>{
        serviceMap[c.service_id] = {
            start: new Date(c.start_date.slice(0,4)+'-'+c.start_date.slice(4,6)+'-'+c.start_date.slice(6,8)),
            end: new Date(c.end_date.slice(0,4)+'-'+c.end_date.slice(4,6)+'-'+c.end_date.slice(6,8)),
            weekdays: {
                sun: c.sunday==='1', mon: c.monday==='1', tue: c.tuesday==='1',
                wed: c.wednesday==='1', thu: c.thursday==='1', fri: c.friday==='1', sat: c.saturday==='1'
            }
        };
    });

    // exceptions
    const ex = await loadCSV(CALENDAR_DATES_TXT);
    exceptionsMap = {};
    ex.forEach(e=>{
        const d = e.date.slice(0,4)+'-'+e.date.slice(4,6)+'-'+e.date.slice(6,8);
        exceptionsMap[e.service_id+'_'+d] = e.exception_type; // 1=added, 2=removed
    });
}

function serviceActiveToday(service_id) {
    const today = new Date();
    const dayStr = today.toISOString().slice(0,10);
    const weekdayNames = ['sun','mon','tue','wed','thu','fri','sat'];
    const wday = weekdayNames[today.getDay()];
    const service = serviceMap[service_id];
    if (!service) return false;
    if (today < service.start || today > service.end) return false;
    // Check weekday
    if (!service.weekdays[wday]) return false;
    // Check exceptions
    const exKey = service_id+'_'+dayStr;
    if (exceptionsMap[exKey]) {
        return exceptionsMap[exKey]==='1';
    }
    return true;
}

// === NEAREST STOPS ===
function getNearestStops(lat, lon, count=MAX_NEARBY_STOPS) {
    const arr = stops.map(s=>({
        ...s,
        dist: distance(lat, lon, s.lat, s.lon),
        bear: bearing(lat, lon, s.lat, s.lon)
    })).sort((a,b)=>a.dist-b.dist);
    return arr.slice(0,count);
}

// === FETCH STOP ARRIVALS ===
async function loadStopJson(atco) {
    try {
        const res = await fetch(`${STOP_JSON_BASE}${atco}.json`);
        if (!res.ok) throw new Error(res.statusText);
        const data = await res.json();
        // Filter only trips active today
        return data.filter(trip=>serviceActiveToday(tripsMap[trip.trip_id]));
    } catch(e) {
        console.error('Error loading stop', atco, e);
        return [];
    }
}

// === RENDER ===
async function renderStops(userLoc) {
    const listEl = document.getElementById('stops');
    listEl.innerHTML = '';
    const nearest = getNearestStops(userLoc.lat, userLoc.lon);
    const now = new Date();
    for (const stop of nearest) {
        const arrivals = await loadStopJson(stop.atco);
        const filtered = arrivals.map(a=>({...a, time:new Date(`1970-01-01T${a.arrival_time}Z`)})
            ).filter(a=> {
                const diff = (a.time-now)/60000;
                return diff>=-TIME_WINDOW_PAST_MIN && diff<=TIME_WINDOW_FUTURE_MIN;
            });
        const uniqueArrivals = Array.from(new Map(filtered.map(a=>[a.trip_id+'|'+a.arrival_time,a])).values());
        const stopNumber = parseInt(stop.atco.slice(-6),10);
        const bearingText = degToCompass(stop.bear);
        const gmapsUrl = `https://www.google.com/maps/search/?api=1&query=${stop.lat},${stop.lon}`;
        let html = `<li><strong>${stopNumber} ${stop.name}</strong> (${Math.round(stop.dist)} m, ${bearingText})<br>`;
        if (uniqueArrivals.length) {
            html += '<ul>';
            uniqueArrivals.forEach(a=>{
                html += `<li>${a.route_short} → ${a.trip_headsign} at ${a.arrival_time}</li>`;
            });
            html += '</ul>';
        } else {
            html += '<span class="error">No upcoming arrivals</span>';
        }
        html += ` <a href="${gmapsUrl}" target="_blank">Map</a></li>`;
        listEl.innerHTML += html;
    }
}

// === INIT ===
async function init() {
    try {
        document.getElementById('status').textContent = 'Loading stops…';
        await loadStops();
        document.getElementById('status').textContent = 'Loading GTFS mapping…';
        await loadGTFSMapping();

        document.getElementById('status').textContent = 'Getting location…';
        const pos = await new Promise((resolve, reject)=>{
            navigator.geolocation.getCurrentPosition(resolve,reject,{enableHighAccuracy:true, timeout:10000, maximumAge:0});
        });

        document.getElementById('status').textContent = 'Rendering nearby stops…';
        await renderStops({lat: pos.coords.latitude, lon: pos.coords.longitude});
        document.getElementById('status').textContent = 'Done';
    } catch(e) {
        document.getElementById('status').textContent = 'Error: '+e;
        console.error(e);
    }
}

init();
