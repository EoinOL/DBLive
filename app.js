// Convert degrees to 8-point compass
function degToCompass(deg) {
  const val = Math.floor((deg / 45) + 0.5);
  const compassPoints = ["N","NE","E","SE","S","SW","W","NW"];
  return compassPoints[val % 8];
}

// Distance & bearing
function getDistanceAndBearing(lat1, lon1, lat2, lon2){
  const R=6371000;
  const φ1=lat1*Math.PI/180;
  const φ2=lat2*Math.PI/180;
  const Δφ=(lat2-lat1)*Math.PI/180;
  const Δλ=(lon2-lon1)*Math.PI/180;
  const a=Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
  const c=2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
  const distance=Math.round(R*c);
  const y=Math.sin(Δλ)*Math.cos(φ2);
  const x=Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ);
  const bearingDeg=(Math.atan2(y,x)*180/Math.PI+360)%360;
  return {distance,bearing:degToCompass(bearingDeg)};
}

// Load stops.geojson.gz
async function loadStops(){
  const resp=await fetch('stops.geojson.gz');
  const compressed=new Uint8Array(await resp.arrayBuffer());
  const decompressed=pako.ungzip(compressed,{to:'string'});
  return JSON.parse(decompressed);
}

// Load stop JSON from R2
async function loadStopJson(atcoCode){
  if(!atcoCode){ console.warn("Undefined AtcoCode"); return null;}
  const url=`https://pub-aad94a89c9ea4f6390466b521c65d978.r2.dev/stops/${atcoCode}.json`;
  try{
    const resp=await fetch(url);
    if(!resp.ok){ console.warn(`Stop ${atcoCode} not found`); return null;}
    return await resp.json();
  }catch(err){ console.warn(`Error loading stop ${atcoCode}`,err); return null;}
}

// Load CSV text file
async function loadCSV(path){
  const resp=await fetch(path);
  if(!resp.ok) throw new Error(`Cannot fetch ${path}`);
  const text=await resp.text();
  return text.split('\n').map(l=>l.split(','));
}

// Build GTFS mappings
async function loadGTFSMapping(){
  const dayMap=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const serviceMap={}; // service_id -> [days...]
  const tripMap={};    // trip_id -> service_id

  // calendar.txt
  const calendar=await loadCSV('calendar.txt');
  calendar.forEach(row=>{
    const [service_id,sun,mon,tue,wed,thu,fri,sat,start_date,end_date]=row;
    if(!service_id) return;
    const days=[];
    if(sun==='1') days.push('Sunday');
    if(mon==='1') days.push('Monday');
    if(tue==='1') days.push('Tuesday');
    if(wed==='1') days.push('Wednesday');
    if(thu==='1') days.push('Thursday');
    if(fri==='1') days.push('Friday');
    if(sat==='1') days.push('Saturday');
    serviceMap[service_id]=days;
  });

  // calendar_dates.txt
  const caldates=await loadCSV('calendar_dates.txt');
  caldates.forEach(row=>{
    const [service_id,date,exception_type]=row;
    if(!service_id || !date) return;
    if(!serviceMap[service_id]) serviceMap[service_id]=[];
    const dt=new Date(date.slice(0,4)+'-'+date.slice(4,6)+'-'+date.slice(6,8));
    const weekday=dayMap[dt.getDay()];
    if(exception_type==='1'){ // added
      if(!serviceMap[service_id].includes(weekday)) serviceMap[service_id].push(weekday);
    } else if(exception_type==='2'){ // removed
      serviceMap[service_id]=serviceMap[service_id].filter(d=>d!==weekday);
    }
  });

  // trips.txt.gz
  const tripsResp=await fetch('trips.txt.gz');
  const tripsCompressed=new Uint8Array(await tripsResp.arrayBuffer());
  const tripsText=pako.ungzip(tripsCompressed,{to:'string'});
  const tripsLines=tripsText.split('\n');
  tripsLines.forEach(line=>{
    const cols=line.split(',');
    const trip_id=cols[2]; // assuming GTFS order: route_id,service_id,trip_id,...
    const service_id=cols[1];
    if(trip_id && service_id) tripMap[trip_id]=service_id;
  });

  return {serviceMap,tripMap};
}

// Filter arrivals & attach weekdays
function enrichArrivals(arrivals, tripMap, serviceMap){
  if(!arrivals) return [];
  return arrivals.map(a=>{
    const service_id=tripMap[a.trip_id];
    const weekdays=service_id ? (serviceMap[service_id] || []) : [];
    return {...a, weekdays};
  });
}

// Main render
async function renderStops(){
  const stopsData=await loadStops();
  if(!stopsData) return;

  let userLoc;
  try{ userLoc=await new Promise((res,rej)=>navigator.geolocation.getCurrentPosition(p=>res(p.coords),e=>rej(e))); }
  catch(err){ console.error("Cannot get location:",err); document.getElementById('stops').textContent="Cannot determine location."; return;}

  const stopsWithDistance=stopsData.features.map(f=>{
    const lat=parseFloat(f.properties.Latitude);
    const lon=parseFloat(f.properties.Longitude);
    if(isNaN(lat)||isNaN(lon)){ console.warn("Invalid coordinates for stop:",f); return {...f,distance:Infinity,bearing:'?'} }
    const {distance,bearing}=getDistanceAndBearing(userLoc.latitude,userLoc.longitude,lat,lon);
    return {...f,distance,bearing};
  });

  const nearestStops=stopsWithDistance.sort((a,b)=>a.distance-b.distance).slice(0,5);
  const container=document.getElementById('stops');
  container.innerHTML='';

  const {serviceMap,tripMap}=await loadGTFSMapping();

  for(const stop of nearestStops){
    const arrivals=await loadStopJson(stop.properties.AtcoCode);
    const enriched=enrichArrivals(arrivals,tripMap,serviceMap);

    const atco=stop.properties.AtcoCode||'';
    const stopNumber=atco ? parseInt(atco.slice(-6),10) : 'unknown';
    const mapsLink=`https://www.google.com/maps/search/?api=1&query=${stop.properties.Latitude},${stop.properties.Longitude}`;

    const stopDiv=document.createElement('div');
    stopDiv.className='stop';

    const stopHeader=document.createElement('h3');
    stopHeader.textContent=`${stop.properties.SCN_English||'Unknown'} (#${stopNumber})`;

    const distanceEl=document.createElement('a');
    distanceEl.href=mapsLink;
    distanceEl.target='_blank';
    distanceEl.textContent=`${stop.distance} m`;

    const bearingEl=document.createElement('span');
    bearingEl.textContent=` (${stop.bearing})`;

    stopDiv.appendChild(stopHeader);
    stopDiv.appendChild(distanceEl);
    stopDiv.appendChild(bearingEl);

    const arrivalsUl=document.createElement('ul');
    if(!enriched.length){
      const li=document.createElement('li');
      li.textContent="No arrivals found.";
      arrivalsUl.appendChild(li);
    } else {
      enriched.forEach(a=>{
        const li=document.createElement('li');
        const days=a.weekdays.length? a.weekdays.join(', ') : 'Unknown day';
        li.textContent=`${a.route_short || '?'} → ${a.trip_headsign || '?'} at ${a.arrival_time || '?'} (${days})`;
        arrivalsUl.appendChild(li);
      });
    }

    stopDiv.appendChild(arrivalsUl);
    container.appendChild(stopDiv);
  }
}

document.addEventListener('DOMContentLoaded', renderStops);
