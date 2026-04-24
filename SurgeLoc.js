/**
 * SurgeLoc
 * 
 * Config: http://loc.config
 * Reference: https://github.com/acheong08/apple-corelocation-experiments
 */

const CONFIG_URL = "http://loc.config";
const STORAGE_KEY = "SURGELOC_DATA";

if ($request.url.startsWith(CONFIG_URL)) {
    handleConfig();
} else if ($request.url.indexOf("/clls/wloc") !== -1) {
    handleLocation();
} else {
    $done({});
}

// --- Config Server ---
async function handleConfig() {
    const url = $request.url;
    const getParam = (name) => {
        const reg = new RegExp("[?&]" + name + "=([^&#]*)", "i");
        const res = reg.exec(url);
        return res ? decodeURIComponent(res[1]) : null;
    };

    if (url.includes("/set?")) {
        const lat = getParam("lat");
        const lon = getParam("lon");
        if (lat && lon) {
            $persistentStore.write(JSON.stringify({ lat: parseFloat(lat), lon: parseFloat(lon) }), STORAGE_KEY);
            $done({ response: { status: 200, body: "OK" } });
        } else {
            $done({ response: { status: 400, body: "Error" } });
        }
        return;
    }

    if (url.includes("/search?")) {
        const input = getParam("q");
        if (input) {
            const searchUrl = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(input)}`;
            $httpClient.get({ url: searchUrl, headers: { "User-Agent": "SurgeLoc/1.0" } }, (err, resp, data) => {
                $done({ response: { status: (err || resp.status !== 200) ? 500 : 200, body: data || "[]", headers: { "Content-Type": "application/json" } } });
            });
        } else {
            $done({ response: { status: 400, body: "[]" } });
        }
        return;
    }

    const saved = JSON.parse($persistentStore.read(STORAGE_KEY) || '{"lat":34.0522,"lon":-118.2437}');
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><title>SurgeLoc</title><link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" /><script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script><style>:root{--bg:#f2f2f7;--acc:#007aff}body{font-family:-apple-system,sans-serif;background:var(--bg);padding:15px;margin:0}#map{height:300px;width:100%;border-radius:15px;margin-bottom:15px;box-shadow:0 2px 10px rgba(0,0,0,0.1);z-index:1}.card{background:#fff;border-radius:15px;padding:16px;margin-bottom:15px;box-shadow:0 1px 3px rgba(0,0,0,.05)}.label{font-size:11px;color:#8e8e93;text-transform:uppercase;margin-bottom:8px;font-weight:600}input{width:100%;border:1px solid #d1d1d6;border-radius:10px;padding:12px;font-size:16px;margin-bottom:12px;box-sizing:border-box;outline:none}button{width:100%;background:var(--acc);color:#fff;border:none;border-radius:10px;padding:14px;font-weight:700;font-size:16px;cursor:pointer}button:disabled{background:#d1d1d6}.footer{font-size:10px;color:#c7c7cc;text-align:center;margin-top:10px}.footer a{color:#c7c7cc;text-decoration:none}.leaflet-popup-content{font-family:monospace;font-weight:bold;text-align:center}</style></head><body><div id="map"></div><div class="card"><div class="label">Address or Coords / 地址或座標</div><input type="text" id="i" placeholder="Taipei 101, etc."><button id="btn" onclick="resolve()">Apply / 套用修改</button></div><div class="footer"><a href="https://github.com/acheong08/apple-corelocation-experiments" target="_blank">github.com/acheong08/apple-corelocation-experiments</a></div><script>
    var currentLat = ${saved.lat}; var currentLon = ${saved.lon};
    var map = L.map('map').setView([currentLat, currentLon], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);
    var marker = L.marker([currentLat, currentLon], {draggable: true}).addTo(map);
    marker.bindPopup(getPopupContent(currentLat, currentLon)).openPopup();

    map.on('click', function(e) { updatePos(e.latlng.lat, e.latlng.lng); });
    marker.on('drag', function(e) { let p = marker.getLatLng(); marker.getPopup().setContent(getPopupContent(p.lat, p.lng)); });
    marker.on('dragend', function(e) { let p = marker.getLatLng(); updatePos(p.lat, p.lng); });

    function getPopupContent(lat, lon) { return lat.toFixed(6) + "<br>" + lon.toFixed(6); }
    function updatePos(lat, lon) {
        currentLat = lat; currentLon = lon;
        marker.setLatLng([lat, lon]);
        marker.getPopup().setContent(getPopupContent(lat, lon));
        marker.openPopup();
        document.getElementById('i').value = lat.toFixed(6) + ', ' + lon.toFixed(6);
    }

    async function resolve() {
        const btn = document.getElementById('btn');
        const input = document.getElementById('i').value.trim();
        if(!input) return;
        let parts = input.split(/[ ,，]+/);
        if(parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
            await save(parseFloat(parts[0]), parseFloat(parts[1]));
            return;
        }
        btn.disabled = true; btn.innerText = 'Searching...';
        try {
            const res = await fetch('/search?q=' + encodeURIComponent(input) + '&t=' + Date.now());
            const data = await res.json();
            if(data && data.length > 0) {
                let lat = parseFloat(data[0].lat), lon = parseFloat(data[0].lon);
                map.flyTo([lat, lon], 15);
                updatePos(lat, lon);
                await save(lat, lon);
            } else { alert('Location not found'); }
        } catch(e) { alert('Search Failed'); } finally {
            btn.disabled = false; btn.innerText = 'Apply / 套用修改';
        }
    }
    async function save(lat, lon) {
        const btn = document.getElementById('btn');
        await fetch('/set?lat='+lat+'&lon='+lon + '&t=' + Date.now());
        btn.disabled = false; btn.innerText = 'Apply / 套用修改';
        alert('Applied! / 位置已套用！\\n\\nMandatory Step: You MUST restart "Location Services" in System Settings to apply changes.\\n必要步驟：請務必重啟系統「定位服務」開關，否則位置不會變更。');
    }
    </script></body></html>`;
    $done({ response: { status: 200, body: html, headers: { "Content-Type": "text/html" } } });
}

// --- Location Injector ---
function handleLocation() {
    try {
        const saved = JSON.parse($persistentStore.read(STORAGE_KEY) || '{"lat":34.052235,"lon":-118.243683}');
        const rawBody = new Uint8Array($request.body);
        let bssids = [];
        for (let i = 0; i < rawBody.length - 20; i++) {
            if (rawBody[i] === 0x0a && rawBody[i+1] === 0x11) {
                bssids.push(rawBody.slice(i + 2, i + 19));
                i += 18;
            }
        }
        if (bssids.length === 0) bssids.push(new TextEncoder().encode("aa:bb:cc:dd:ee:ff"));
        const latInt = BigInt(Math.round(saved.lat * 1e8));
        const lonInt = BigInt(Math.round(saved.lon * 1e8));
        const now = BigInt(Math.floor(Date.now() / 1000));
        let locBuf = [...wb(1, latInt), ...wb(2, lonInt), ...wb(3, 20n), ...wb(9, now)];
        let allWifiBuf = [];
        for (let mac of bssids) {
            let wifi = [0x0a, 0x11, ...mac, ...wl(2, locBuf)];
            allWifiBuf.push(...wl(2, wifi));
        }
        let appBuf = [...allWifiBuf, ...wb(4, BigInt(bssids.length)), ...wb(5, 0n)];
        let res = new Uint8Array(10 + appBuf.length);
        res.set([0x00, 0x01, 0x00, 0x00, 0x00, 0x01], 0);
        let l = appBuf.length;
        res[6] = (l >> 24) & 0xff; res[7] = (l >> 16) & 0xff; res[8] = (l >> 8) & 0xff; res[9] = l & 0xff;
        res.set(appBuf, 10);
        $done({ response: { status: 200, body: res.buffer.slice(0, res.length), headers: { "Content-Type": "application/x-protobuf" } } });
    } catch (e) {
        $done({});
    }
}

function wb(t, v) {
    let buf = [(t << 3) | 0];
    let b = BigInt(v);
    if (b < 0n) {
        for (let i = 0; i < 9; i++) { buf.push(Number((b & 0x7Fn) | 0x80n)); b >>= 7n; }
        buf.push(1);
    } else {
        while (b > 127n) { buf.push(Number((b & 0x7Fn) | 0x80n)); b >>= 7n; }
        buf.push(Number(b));
    }
    return buf;
}
function wl(t, d) {
    let buf = [(t << 3) | 2];
    let l = d.length;
    while (l > 127) { buf.push((l & 127) | 128); l >>= 7; }
    buf.push(l);
    return buf.concat(d);
}
