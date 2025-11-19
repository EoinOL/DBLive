// ----------------------------
// 1. Load GTFS-RT feed
// ----------------------------
async function loadRealtimeTrips() {
    const url = "https://falling-firefly-fd90.eoinol.workers.dev/";

    const res = await fetch(url);
    if (!res.ok) {
        console.error("GTFS-RT fetch failed:", res.status);
        return {};
    }

    const data = await res.json();
    const tripMap = {};

    for (const ent of data.entity || []) {
        if (!ent.trip_update) continue;

        const t = ent.trip_update.trip;

        tripMap[t.trip_id] = {
            start_time: t.start_time || null,
            start_date: t.start_date || null,
            route_id: t.route_id || null,
            direction_id: t.direction_id,
            relationship: t.schedule_relationship || "SCHEDULED",
            updates: ent.trip_update.stop_time_update || []
        };
    }

    console.log("Realtime trip map:", tripMap);
    return tripMap;
}



// ----------------------------
// 2. Load static stop-time JSON (your local JSON files)
// ----------------------------
async function loadStaticStop(stopId) {
    const url = `./stops/${stopId}.json`;

    try {
        const res = await fetch(url);
        if (!res.ok) return null;
        return await res.json();
    } catch (e) {
        console.error("Static stop load failed", e);
        return null;
    }
}



// ----------------------------
// 3. Lookup function
// ----------------------------
async function lookupStop() {
    const stopId = document.getElementById("stopInput").value.trim();
    const results = document.getElementById("results");

    if (!stopId) {
        results.innerHTML = "Enter a stop ID";
        return;
    }

    results.innerHTML = "Loading...";

    const rtTrips = await loadRealtimeTrips();
    const staticStopData = await loadStaticStop(stopId);

    if (!staticStopData) {
        results.innerHTML = "Stop not found in static data.";
        return;
    }

    const staticArrivals = staticStopData.arrivals || [];

    // -------------- Important ----------------
    // Keep only static entries that match an RT trip
    // -----------------------------------------
    const mergedTrips = staticArrivals
        .filter(a => rtTrips[a.trip_id])  // ONLY real-time confirmed trips
        .map(a => ({
            trip_id: a.trip_id,
            route: a.route,
            direction: a.direction,
            static_time: a.time, // scheduled time from static JSON
            rt: rtTrips[a.trip_id]
        }));

    // No RT? Then the stop has no service right now.
    if (mergedTrips.length === 0) {
        results.innerHTML = "No active real-time trips for this stop.";
        return;
    }

    // Render
    let html = `<div class='header'>Stop ${stopId}</div>`;

    for (const trip of mergedTrips) {
        html += `
            <div class="trip">
                <div><b>${trip.route}</b> → ${trip.direction}</div>
                <div>Scheduled: ${trip.static_time}</div>
                <div>Trip ID: ${trip.trip_id}</div>
                <div>RT start: ${trip.rt.start_time || "?"}</div>
                <div>Delays: ${
                    trip.rt.updates.length > 0 ? 
                        trip.rt.updates[0].arrival?.delay + "s" :
                        "none"
                }</div>
            </div>
        `;
    }

    results.innerHTML = html;
}
