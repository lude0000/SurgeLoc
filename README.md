# SurgeLoc

iOS System-wide Location Spoofing Tool (Surge Script)
iOS 全系統定位修改工具 (Surge 腳本版)

---

## English Version

### ⚠️ Important Notes
1. **Service Impact & Recovery**: This module uses MITM to intercept multiple Apple official server domains. This will cause most native Apple services to suspend during operation.
2. **CRITICAL STEP**: When you stop using simulation, you **MUST** disable the Surge module **AND** restart **Settings > Privacy & Security > Location Services** (toggle off/on) to restore your actual location. Failure to do so may result in the system being stuck at the spoofed location.

### 🚀 Usage
1. **Install Module**: `https://raw.githubusercontent.com/lude0000/SurgeLoc/main/SurgeLoc.sgmodule`
2. **Configuration**: Open `http://loc.config` in your browser.
3. **Apply Changes**: Click the "Apply" button in the interface.
4. **MANDATORY STEP**: After applying changes (or after disabling the module), you **MUST** go to **Settings > Privacy & Security > Location Services**, toggle it off and then on. **The location will not update until this step is performed.**

### 💡 Principle
* **Protocol Interception**: Intercepts binary communication (ARPC/Protobuf) between `locationd` and Apple servers.
* **Environment Spoofing**: Automatically extracts real Wi-Fi BSSIDs and injects them into response packets to pass system validity checks.
* **Coordinate Injection**: Dynamically injects spoofed coordinates for system-wide teleportation.

### 🔗 References
* [acheong08/apple-corelocation-experiments](https://github.com/acheong08/apple-corelocation-experiments)
* [Surge Manual](https://manual.nssurge.com/scripting/common.html)

---

## 繁體中文版

### ⚠️ 重要注意事項
1. **服務影響與恢復**：本模組透過 MITM 攔截多個 Apple 官方伺服器網域以實現定位修改，這將導致大部分 Apple 原生服務在開啟期間因請求被攔截而暫停。
2. **關鍵恢復步驟**：當您停止模擬時，**除了關閉 Surge 模組外，務必再次重啟系統「定位服務」開關**（關閉後開啟）。

### 🚀 操作指南
1. **安裝模組**： `https://raw.githubusercontent.com/lude0000/SurgeLoc/main/SurgeLoc.sgmodule`
2. **位置設定**：使用瀏覽器開啟 `http://loc.config`
3. **套用修改**：點擊介面中的「Apply / 套用修改」按鈕。
4. **必要步驟**：不論是「套用位置」後，還是「關閉模組」後，**皆務必**至 **系統設定 > 隱私權與安全性 > 定位服務**，將其**「關閉後重新開啟」**。**若不執行此步驟，定位將不會刷新。**

### 💡 技術原理
* **協議攔截**：攔截 `locationd` 與 Apple 伺服器間的二進位通訊 (ARPC/Protobuf)。
* **環境模擬**：自動提取真實 Wi-Fi BSSID 並回填至響應包，確保通過系統驗證。
* **座標注入**：動態注入偽造經緯度，實現全系統定點偏移。

### 🔗 參考來源
* [acheong08/apple-corelocation-experiments](https://github.com/acheong08/apple-corelocation-experiments)
* [Surge 官方文檔](https://manual.nssurge.com/scripting/common.html)

---

## 免責聲明 / Disclaimer
本工具僅供技術研究與網路調試使用，使用者須自行承擔因修改系統數據而產生的所有風險，包括但不限於帳號限制或資料異常。
This tool is for technical research and network debugging only. Users assume all risks associated with modifying system data, including but not limited to account restrictions or data anomalies.
