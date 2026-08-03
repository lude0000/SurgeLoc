# SurgeLoc

用 Surge 攔截 iOS 的網路定位(`gs-loc`)回應,把座標覆蓋成你指定的位置;本機系統會認定覆蓋後的座標為目前位置。
System-wide iOS location override via a Surge script — it intercepts Apple's network-location (`gs-loc`) response and overwrites the coordinates with a location you choose, which the system then treats as your current position.

---

## 繁體中文版

### 安裝 Install
Surge → 模組,加入模組網址並啟用:
```
https://raw.githubusercontent.com/lude0000/SurgeLoc/main/SurgeLoc.sgmodule
```
模組會 MITM `gs-loc.apple.com` 等定位端點,並在 `loc.config` 提供控制台與 HTTP API —— 皆在本機處理,座標不外流。

### 使用說明 Usage
1. **加入主畫面(建議)**:瀏覽器開 `http://loc.config` → 分享 → 加入主畫面,之後從主畫面圖示以全螢幕網頁 App 開啟。
2. **選點**,三種方式擇一:
   - 點地圖任一處 → 彈出座標,按 **移動** 改定位(或 **收藏**)。
   - 上方搜尋列輸入地址或 `緯度,經度` → **前往**。
   - 右下選單 → **⭐ 收藏** → 點一筆會飛到該點,再按 **移動** 套用。
3. **刷新定位快取(必要)**:到「設定 → 隱私權與安全性 → 定位服務」,把開關**關閉再開啟**。
4. **恢復真實定位**:右下選單 → **復原**(同樣重啟一次定位服務開關)。

**收藏**支援多層分類(資料夾式路徑)、進「編輯」模式可拖曳排序 / 換分類 / 新增改名刪除分類,每筆自動帶地名與當地時間。

> 如果沒有成功多試幾次把「定位服務」開關關再開即可。

### 捷徑 Shortcut
一個捷徑就搞定:從 **Google 地圖或 Apple 地圖** 把地點**分享**給它,取出座標後選 **定位** 或 **收藏**:
- **定位** → 呼叫 `/set?lat=&lon=` 改定位,並自動跳到「定位服務」開關讓你關再開。
- **收藏** → 呼叫 `/fav/add?lat=&lon=`(未指定分類 → 自動歸「未分類」)。

取得捷徑:**[加入捷徑](https://www.icloud.com/shortcuts/2dc50ce5ee67426fa8058ac08fa2dee4)**

> Google 地圖需展開短網址,偶爾會延遲或轉不到,多試幾次即可。

> iOS 的權限是**依來源/網址逐一詢問**,前幾次執行會跳好幾次(視你從哪個地圖分享而定;Google 地圖流程還會多短網址與 `google.com`)。每個都按 **永遠允許**,全部允許過後就不會再出現。

### HTTP API
所有請求打向 host `loc.config`(已在模組 MITM 宣告),回傳 JSON。

| Endpoint | 說明 |
|---|---|
| `/set?lat=<緯度>&lon=<經度>` | 設定座標(也接受 `?q=<座標字串>`) |
| `/clear`(或 `/restore`) | 恢復真實定位 |
| `/search?q=<地名>` | 地理編碼:地名 → 座標(Nominatim) |
| `/reverse?lat=&lon=` | 反向地理編碼:座標 → 地名 |
| `/fav/list` | 收藏清單 + 分類樹 |
| `/fav/add?path=<分類>&lat=&lon=&place=` | 新增收藏(`path` 用 `/` 分層;空 = 未分類) |
| `/fav/move?id=&path=&before=` | 移動 / 排序(拖曳用) |
| `/fav/apply?id=` | 套用某收藏 |
| `/fav/del?id=` | 刪除收藏 |
| `/cat/add?path=` · `/cat/rename?from=&to=` · `/cat/del?path=` | 分類新增 / 改名 / 刪除 |

> `path` 例:`旅遊/日本/東京`。`/cat/rename`、`/cat/del` 會連同子分類一起處理。

### 原理 How it works
攔截 Apple 網路定位(`gs-loc`)回應,把其中 Wi-Fi 熱點與基地台記錄的座標欄位覆蓋成指定座標;本機系統即認定覆蓋後的座標。解析失敗時原樣放行,不中斷定位服務。

---

## English Version

### Install
In Surge → Modules, add this URL and enable it:
```
https://raw.githubusercontent.com/lude0000/SurgeLoc/main/SurgeLoc.sgmodule
```
The module MITMs `gs-loc.apple.com` and serves a control panel + HTTP API at `loc.config` — everything is handled on-device, coordinates never leave your phone.

### Usage
1. **Add to Home Screen (recommended)**: open `http://loc.config` in a browser → Share → Add to Home Screen, then launch from the icon as a full-screen web app.
2. **Pick a location** (any one):
   - Tap the map → a popup shows the coordinate; press **Move** to apply (or **Save**).
   - Type an address or `lat,lon` in the top search bar → **Go**.
   - Bottom-right menu → **⭐ Saved** → tap an entry to fly there, then press **Move**.
3. **Refresh location cache (required)**: Settings → Privacy & Security → Location Services, toggle it **off then on**.
4. **Restore real location**: bottom-right menu → **Restore** (toggle Location Services again).

**Saved places** support nested categories (folder-style paths); in Edit mode you can drag to reorder / move between categories / add-rename-delete categories. Each entry auto-shows a place name and local time.

> If it doesn't work, toggle "Location Services" off/on a few more times.

### Shortcut
One shortcut does it all: share a place from **Google Maps or Apple Maps** to it, then choose **Set** or **Save**:
- **Set** → calls `/set?lat=&lon=` to change location, then jumps straight to the Location Services toggle.
- **Save** → calls `/fav/add?lat=&lon=` (no category → "未分類").

Get the shortcut: **[Add to Shortcuts](https://www.icloud.com/shortcuts/2dc50ce5ee67426fa8058ac08fa2dee4)**

> Google Maps requires expanding a short link, which can occasionally lag or fail — just try again a few times.

> iOS asks permission **per source/URL**, so the first runs pop up several prompts (which ones depends on the map app you share from; the Google Maps path also hits the short link and `google.com`). Choose **Always Allow** on every one; once all are approved they stop appearing.

### HTTP API
All requests go to host `loc.config` (declared in the module's MITM) and return JSON.

| Endpoint | Description |
|---|---|
| `/set?lat=<lat>&lon=<lon>` | Set coordinate (also accepts `?q=<coord string>`) |
| `/clear` (or `/restore`) | Restore real location |
| `/search?q=<place>` | Geocode: place name → coordinate (Nominatim) |
| `/reverse?lat=&lon=` | Reverse geocode: coordinate → place name |
| `/fav/list` | Saved list + category tree |
| `/fav/add?path=<cat>&lat=&lon=&place=` | Add (`path` uses `/`; empty = 未分類) |
| `/fav/move?id=&path=&before=` | Move / reorder (drag) |
| `/fav/apply?id=` | Apply a saved place |
| `/fav/del?id=` | Delete a saved place |
| `/cat/add?path=` · `/cat/rename?from=&to=` · `/cat/del?path=` | Add / rename / delete category |

### How it works
Intercepts Apple's network-location (`gs-loc`) response and overwrites the coordinate fields inside its Wi-Fi hotspot and cell-tower records; the system then accepts the overwritten coordinate. On parse failure the response passes through untouched, so location services never break.

---

## 參考 Credits
* [acheong08/apple-corelocation-experiments](https://github.com/acheong08/apple-corelocation-experiments) — 原始研究 / original research
* [Surge Manual](https://manual.nssurge.com/scripting/common.html)

## 免責聲明 Disclaimer
本工具僅供技術研究與網路調試使用,使用者須自行承擔因覆蓋系統定位數據而產生的所有風險,包括但不限於帳號限制或資料異常。
This tool is for technical research and network debugging only. Users assume all risks associated with overwriting location data.
