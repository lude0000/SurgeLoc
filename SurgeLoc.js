/*
 * SurgeLoc — iOS 全系統定位模擬(Surge 腳本)
 *
 * 兩部分:
 *   1. wloc 回應覆蓋引擎:攔 gs-loc /clls/wloc,拆 ARPC → protobuf 解欄位
 *      → 替換 Wi-Fi 熱點 / 基地台的座標與精度 → 依原格式(ARPC / marker / synthetic)封回
 *   2. loc.config 附加層:控制台網頁 + HTTP API(選點 / 收藏 / 搜尋),座標存 persistentStore
 */
(function () {
  "use strict";

  var DEFAULT_CONFIG = {
    enabled: true,
    mode: "response",
    latitude: 37.3349,
    longitude: -122.00902,
    horizontalAccuracy: 39,
    verticalAccuracy: 1000,
    altitude: 530,
    unknownValue4: 3,
    motionActivityType: 63,
    motionActivityConfidence: 467,
    failOpen: true,
    debug: false,
    dumpRaw: false,
    dumpHeaders: false,
    prepareHeaders: false,
    rawLimit: 0
  };

  // Prefix prepended to a SPOOFED (synthesized) response. Mirrors the original Go
  // `initialBytes = 0001000000010000` from main.go:253.
  var APPLE_WLOC_PREFIX = bytesFromArray([0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00]);

  // Stable marker that precedes the AppleWLoc protobuf inside a REAL Apple /clls/wloc
  // response. After the marker come 2 bytes (uint16 BE payload length) then the payload.
  var APPLE_WLOC_MARKER = bytesFromArray([0x00, 0x00, 0x00, 0x01, 0x00, 0x00]);
  var ROOT_DROP_FIELDS = { 3: true, 4: true, 33: true };
  var CELL_RESPONSE_FIELDS = { 22: true, 24: true };
  var LOCATION_REPLACED_FIELDS = {
    1: true,
    2: true,
    3: true,
    4: true,
    5: true,
    6: true,
    11: true,
    12: true
  };

  function bytesFromArray(values) {
    return new Uint8Array(values);
  }

  function concatBytes(parts) {
    var total = 0;
    var i;
    for (i = 0; i < parts.length; i += 1) {
      total += parts[i].length;
    }

    var out = new Uint8Array(total);
    var offset = 0;
    for (i = 0; i < parts.length; i += 1) {
      out.set(parts[i], offset);
      offset += parts[i].length;
    }
    return out;
  }

  function bytesEqualPrefix(bytes, prefix) {
    if (!bytes || bytes.length < prefix.length) {
      return false;
    }
    for (var i = 0; i < prefix.length; i += 1) {
      if (bytes[i] !== prefix[i]) {
        return false;
      }
    }
    return true;
  }

  // Search for a byte sequence within bytes; returns first index or -1.
  // Searches forward to prefer the earliest (most likely correct) match.
  function findBytes(bytes, marker) {
    if (!bytes || !marker || marker.length === 0) {
      return -1;
    }
    for (var i = 0; i <= bytes.length - marker.length; i += 1) {
      var ok = true;
      for (var j = 0; j < marker.length; j += 1) {
        if (bytes[i + j] !== marker[j]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        return i;
      }
    }
    return -1;
  }

  // Try to parse bytes as protobuf fields. Returns fields array or null on failure.
  function tryParseFields(bytes) {
    try {
      if (!bytes || bytes.length === 0) {
        return null;
      }
      var fields = parseFields(bytes);
      return fields.length > 0 ? fields : null;
    } catch (e) {
      return null;
    }
  }

  function binaryStringToBytes(value) {
    var out = new Uint8Array(value.length);
    for (var i = 0; i < value.length; i += 1) {
      out[i] = value.charCodeAt(i) & 0xff;
    }
    return out;
  }

  function bytesToBinaryString(bytes) {
    var chunkSize = 0x8000;
    var chunks = [];
    for (var i = 0; i < bytes.length; i += chunkSize) {
      var chunk = bytes.subarray(i, i + chunkSize);
      chunks.push(String.fromCharCode.apply(null, Array.prototype.slice.call(chunk)));
    }
    return chunks.join("");
  }

  function bytesToBase64(bytes) {
    var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    var out = "";
    for (var i = 0; i < bytes.length; i += 3) {
      var b0 = bytes[i];
      var b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
      var b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
      var triplet = (b0 << 16) | (b1 << 8) | b2;
      out += alphabet[(triplet >> 18) & 0x3f];
      out += alphabet[(triplet >> 12) & 0x3f];
      out += i + 1 < bytes.length ? alphabet[(triplet >> 6) & 0x3f] : "=";
      out += i + 2 < bytes.length ? alphabet[triplet & 0x3f] : "=";
    }
    return out;
  }

  function hexPreview(bytes, limit) {
    if (!bytes) {
      return "<none>";
    }
    var out = [];
    var max = Math.min(bytes.length, limit || 16);
    for (var i = 0; i < max; i += 1) {
      out.push(("0" + bytes[i].toString(16)).slice(-2));
    }
    return out.join("");
  }

  function bodyToBytes(body) {
    if (body == null) {
      return null;
    }
    if (body instanceof Uint8Array) {
      return body;
    }
    if (typeof ArrayBuffer !== "undefined" && body instanceof ArrayBuffer) {
      return new Uint8Array(body);
    }
    if (typeof body === "string") {
      return binaryStringToBytes(body);
    }
    if (typeof body === "object" && typeof body.length === "number") {
      return new Uint8Array(body);
    }
    if (typeof body === "object" && body.bytes && typeof body.bytes.length === "number") {
      return new Uint8Array(body.bytes);
    }
    if (typeof body === "object" && body.data && typeof body.data.length === "number") {
      return new Uint8Array(body.data);
    }
    return null;
  }

  function messageBodyToBytes(message) {
    if (!message) {
      return null;
    }
    return (
      bodyToBytes(message.bodyBytes) ||
      bodyToBytes(message.body) ||
      bodyToBytes(message.rawBody) ||
      bodyToBytes(message.binaryBody)
    );
  }

  function readUInt16BE(bytes, offset) {
    if (offset + 2 > bytes.length) {
      throw new Error("uint16 out of range");
    }
    return (bytes[offset] << 8) | bytes[offset + 1];
  }

  function readUInt32BE(bytes, offset) {
    if (offset + 4 > bytes.length) {
      throw new Error("uint32 out of range");
    }
    return (
      (bytes[offset] * 0x1000000) +
      ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3])
    ) >>> 0;
  }

  function writeUInt16BE(value) {
    if (value < 0 || value > 0xffff) {
      throw new Error("uint16 value out of range: " + value);
    }
    return bytesFromArray([(value >> 8) & 0xff, value & 0xff]);
  }

  function writeUInt32BE(value) {
    return bytesFromArray([
      (value >>> 24) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff
    ]);
  }

  function asciiBytes(value) {
    var out = new Uint8Array(value.length);
    for (var i = 0; i < value.length; i += 1) {
      out[i] = value.charCodeAt(i) & 0x7f;
    }
    return out;
  }

  function encodeVarintUnsigned(value) {
    var v = typeof value === "bigint" ? value : BigInt(value);
    if (v < 0n) {
      throw new Error("negative unsigned varint");
    }

    var out = [];
    while (v >= 0x80n) {
      out.push(Number((v & 0x7fn) | 0x80n));
      v >>= 7n;
    }
    out.push(Number(v));
    return bytesFromArray(out);
  }

  function encodeVarintSignedInt64(value) {
    var v = typeof value === "bigint" ? value : BigInt(Math.trunc(value));
    if (v < 0n) {
      v = BigInt.asUintN(64, v);
    }
    return encodeVarintUnsigned(v);
  }

  function decodeVarint(bytes, offset) {
    var result = 0n;
    var shift = 0n;
    var current = offset;

    while (current < bytes.length) {
      var b = bytes[current];
      current += 1;
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) {
        return { value: result, offset: current };
      }
      shift += 7n;
      if (shift > 70n) {
        throw new Error("varint too long");
      }
    }

    throw new Error("unterminated varint");
  }

  function makeKey(fieldNumber, wireType) {
    return encodeVarintUnsigned((BigInt(fieldNumber) << 3n) | BigInt(wireType));
  }

  function makeVarintField(fieldNumber, value) {
    return concatBytes([makeKey(fieldNumber, 0), encodeVarintSignedInt64(value)]);
  }

  function makeLengthDelimitedField(fieldNumber, payload) {
    return concatBytes([makeKey(fieldNumber, 2), encodeVarintUnsigned(payload.length), payload]);
  }

  function parseFields(bytes) {
    var fields = [];
    var offset = 0;

    while (offset < bytes.length) {
      var keyStart = offset;
      var key = decodeVarint(bytes, offset);
      offset = key.offset;

      var fieldNumber = Number(key.value >> 3n);
      var wireType = Number(key.value & 0x7n);
      if (fieldNumber === 0) {
        throw new Error("protobuf field number 0");
      }

      var valueStart = offset;
      var valueEnd;
      if (wireType === 0) {
        valueEnd = decodeVarint(bytes, offset).offset;
      } else if (wireType === 1) {
        valueEnd = offset + 8;
      } else if (wireType === 2) {
        var lengthInfo = decodeVarint(bytes, offset);
        var length = Number(lengthInfo.value);
        valueStart = lengthInfo.offset;
        valueEnd = valueStart + length;
      } else if (wireType === 5) {
        valueEnd = offset + 4;
      } else {
        throw new Error("unsupported protobuf wire type: " + wireType);
      }

      if (valueEnd > bytes.length) {
        throw new Error("protobuf field exceeds buffer");
      }

      fields.push({
        fieldNumber: fieldNumber,
        wireType: wireType,
        keyStart: keyStart,
        valueStart: valueStart,
        valueEnd: valueEnd,
        end: valueEnd,
        raw: bytes.slice(keyStart, valueEnd),
        valueBytes: bytes.slice(valueStart, valueEnd)
      });
      offset = valueEnd;
    }

    return fields;
  }

  function firstFieldByNumber(fields, fieldNumber) {
    for (var i = 0; i < fields.length; i += 1) {
      if (fields[i].fieldNumber === fieldNumber) {
        return fields[i];
      }
    }
    return null;
  }

  function signedVarintFieldValue(field) {
    if (!field || field.wireType !== 0) {
      return null;
    }
    return BigInt.asIntN(64, decodeVarint(field.valueBytes, 0).value);
  }

  function locationSummary(locationPayload) {
    try {
      var fields = parseFields(locationPayload);
      var lat = signedVarintFieldValue(firstFieldByNumber(fields, 1));
      var lon = signedVarintFieldValue(firstFieldByNumber(fields, 2));
      if (lat == null || lon == null) {
        return "<missing>";
      }
      return (Number(lat) / 100000000).toFixed(8) + "," + (Number(lon) / 100000000).toFixed(8);
    } catch (err) {
      return "<parse-failed:" + err.message + ">";
    }
  }

  function patchedPayloadSummary(payload) {
    try {
      var rootFields = parseFields(payload);
      var parts = [];
      var wifi = firstFieldByNumber(rootFields, 2);
      if (wifi && wifi.wireType === 2) {
        var wifiLocation = firstFieldByNumber(parseFields(wifi.valueBytes), 2);
        parts.push("firstWifi=" + (wifiLocation ? locationSummary(wifiLocation.valueBytes) : "<missing>"));
      }
      var cell = firstCellResponseField(rootFields);
      if (cell && cell.wireType === 2) {
        var cellLocation = firstFieldByNumber(parseFields(cell.valueBytes), 5);
        parts.push("firstCell=" + (cellLocation ? locationSummary(cellLocation.valueBytes) : "<missing>"));
      }
      return parts.length ? parts.join(", ") : "no wifi/cell location fields";
    } catch (err) {
      return "summary failed: " + err.message;
    }
  }

  function isCellResponseField(fieldNumber) {
    return CELL_RESPONSE_FIELDS[fieldNumber] === true;
  }

  function firstCellResponseField(fields) {
    for (var i = 0; i < fields.length; i += 1) {
      if (isCellResponseField(fields[i].fieldNumber)) {
        return fields[i];
      }
    }
    return null;
  }

  function coordToInt(value) {
    // 使用 Math.trunc 精确匹配 Go: int64(coord * 1e8)
    return Math.trunc(Number(value) * 100000000);
  }

  function parseBoolean(value, defaultValue) {
    if (value === true || value === false) {
      return value;
    }
    if (typeof value === "string") {
      var normalized = value.trim().toLowerCase();
      if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
        return true;
      }
      if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") {
        return false;
      }
    }
    return defaultValue;
  }

  function normalizeConfig(input) {
    var cfg = {};
    var key;
    for (key in DEFAULT_CONFIG) {
      if (Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, key)) {
        cfg[key] = DEFAULT_CONFIG[key];
      }
    }
    input = input || {};
    for (key in input) {
      if (Object.prototype.hasOwnProperty.call(input, key)) {
        cfg[key] = input[key];
      }
    }

    cfg.enabled = parseBoolean(cfg.enabled, true);
    cfg.failOpen = parseBoolean(cfg.failOpen, true);
    var mode = String(cfg.mode || "response").toLowerCase();
    cfg.mode = mode === "request" || mode === "prepare" || mode === "probe" || mode === "inspect" ? mode : "response";
    cfg.latitude = Number(cfg.latitude);
    cfg.longitude = Number(cfg.longitude);
    cfg.horizontalAccuracy = Math.trunc(Number(cfg.horizontalAccuracy));
    cfg.verticalAccuracy = Math.trunc(Number(cfg.verticalAccuracy));
    cfg.altitude = Math.trunc(Number(cfg.altitude));
    cfg.unknownValue4 = Math.trunc(Number(cfg.unknownValue4));
    cfg.motionActivityType = Math.trunc(Number(cfg.motionActivityType));
    cfg.motionActivityConfidence = Math.trunc(Number(cfg.motionActivityConfidence));
    cfg.dumpRaw = cfg.dumpRaw === true || String(cfg.dumpRaw).toLowerCase() === "true";
    cfg.dumpHeaders = cfg.dumpHeaders === true || String(cfg.dumpHeaders).toLowerCase() === "true";
    cfg.prepareHeaders = cfg.prepareHeaders === true || String(cfg.prepareHeaders).toLowerCase() === "true";
    cfg.rawLimit = Math.trunc(Number(cfg.rawLimit || 0));
    if (!Number.isFinite(cfg.rawLimit) || cfg.rawLimit < 0) {
      cfg.rawLimit = 0;
    }

    if (!Number.isFinite(cfg.latitude) || cfg.latitude < -90 || cfg.latitude > 90) {
      throw new Error("invalid latitude");
    }
    if (!Number.isFinite(cfg.longitude) || cfg.longitude < -180 || cfg.longitude > 180) {
      throw new Error("invalid longitude");
    }
    return cfg;
  }

  function patchLocation(locationPayload, config) {
    var parts = [];
    var fields = locationPayload.length ? parseFields(locationPayload) : [];
    for (var i = 0; i < fields.length; i += 1) {
      if (!LOCATION_REPLACED_FIELDS[fields[i].fieldNumber]) {
        parts.push(fields[i].raw);
      }
    }

    parts.push(makeVarintField(1, coordToInt(config.latitude)));
    parts.push(makeVarintField(2, coordToInt(config.longitude)));
    parts.push(makeVarintField(3, config.horizontalAccuracy));
    parts.push(makeVarintField(4, config.unknownValue4));
    parts.push(makeVarintField(5, config.altitude));
    parts.push(makeVarintField(6, config.verticalAccuracy));
    parts.push(makeVarintField(11, config.motionActivityType));
    parts.push(makeVarintField(12, config.motionActivityConfidence));
    return concatBytes(parts);
  }

  function patchWifiDevice(wifiPayload, config) {
    var fields = parseFields(wifiPayload);
    var parts = [];
    var patchedLocation = false;

    for (var i = 0; i < fields.length; i += 1) {
      var field = fields[i];
      if (field.fieldNumber === 2 && field.wireType === 2) {
        parts.push(makeLengthDelimitedField(2, patchLocation(field.valueBytes, config)));
        patchedLocation = true;
      } else {
        parts.push(field.raw);
      }
    }

    if (!patchedLocation) {
      parts.push(makeLengthDelimitedField(2, patchLocation(bytesFromArray([]), config)));
    }

    return concatBytes(parts);
  }

  function patchCellTower(cellPayload, config) {
    var fields = parseFields(cellPayload);
    var parts = [];
    var patchedLocation = false;

    for (var i = 0; i < fields.length; i += 1) {
      var field = fields[i];
      if (field.fieldNumber === 5 && field.wireType === 2) {
        parts.push(makeLengthDelimitedField(5, patchLocation(field.valueBytes, config)));
        patchedLocation = true;
      } else {
        parts.push(field.raw);
      }
    }

    if (!patchedLocation) {
      parts.push(makeLengthDelimitedField(5, patchLocation(bytesFromArray([]), config)));
    }

    return concatBytes(parts);
  }

  function patchAppleWLocPayload(payload, config) {
    var fields = parseFields(payload);
    var parts = [];
    var wifiCount = 0;
    var cellCount = 0;

    for (var i = 0; i < fields.length; i += 1) {
      var field = fields[i];
      if (field.fieldNumber === 2 && field.wireType === 2) {
        parts.push(makeLengthDelimitedField(2, patchWifiDevice(field.valueBytes, config)));
        wifiCount += 1;
      } else if (isCellResponseField(field.fieldNumber) && field.wireType === 2) {
        parts.push(makeLengthDelimitedField(field.fieldNumber, patchCellTower(field.valueBytes, config)));
        cellCount += 1;
      } else if (!ROOT_DROP_FIELDS[field.fieldNumber]) {
        parts.push(field.raw);
      }
    }

    return { payload: concatBytes(parts), wifiCount: wifiCount, cellCount: cellCount };
  }

  function readPascalString(bytes, state) {
    var length = readUInt16BE(bytes, state.offset);
    state.offset += 2;
    if (state.offset + length > bytes.length) {
      throw new Error("ARPC pascal string exceeds buffer");
    }

    var chars = [];
    for (var i = 0; i < length; i += 1) {
      chars.push(String.fromCharCode(bytes[state.offset + i]));
    }
    state.offset += length;
    return chars.join("");
  }

  function writePascalString(value) {
    var bytes = asciiBytes(value);
    return concatBytes([writeUInt16BE(bytes.length), bytes]);
  }

  function parseArpc(bytes) {
    var state = { offset: 0 };
    var version = readUInt16BE(bytes, state.offset);
    state.offset += 2;
    var locale = readPascalString(bytes, state);
    var appIdentifier = readPascalString(bytes, state);
    var osVersion = readPascalString(bytes, state);
    var functionId = readUInt32BE(bytes, state.offset);
    state.offset += 4;
    var payloadLength = readUInt32BE(bytes, state.offset);
    state.offset += 4;

    if (state.offset + payloadLength > bytes.length) {
      throw new Error("ARPC payload exceeds buffer");
    }

    return {
      version: version,
      locale: locale,
      appIdentifier: appIdentifier,
      osVersion: osVersion,
      functionId: functionId,
      payload: bytes.slice(state.offset, state.offset + payloadLength)
    };
  }

  function serializeArpc(arpc) {
    return concatBytes([
      writeUInt16BE(arpc.version),
      writePascalString(arpc.locale),
      writePascalString(arpc.appIdentifier),
      writePascalString(arpc.osVersion),
      writeUInt32BE(arpc.functionId),
      writeUInt32BE(arpc.payload.length),
      arpc.payload
    ]);
  }

  function buildAppleWLocResponse(payload, prefix) {
    return concatBytes([prefix || APPLE_WLOC_PREFIX, writeUInt16BE(payload.length), payload]);
  }

  function extractPrefixedAppleWLocPayload(responseBytes) {
    if (!responseBytes || responseBytes.length < 10) {
      return null;
    }
    if (responseBytes[0] !== 0x00 || responseBytes[1] !== 0x01) {
      return null;
    }
    if (responseBytes[6] !== 0x00 || responseBytes[7] !== 0x00) {
      return null;
    }

    var payloadLength = readUInt16BE(responseBytes, 8);
    var payloadOffset = 10;
    if (payloadLength <= 0 || payloadOffset + payloadLength > responseBytes.length) {
      return null;
    }

    var payload = responseBytes.slice(payloadOffset, payloadOffset + payloadLength);
    if (tryParseFields(payload) === null) {
      return null;
    }

    return {
      kind: "synthetic",
      payload: payload,
      prefix: responseBytes.slice(0, 8),
      suffix: responseBytes.slice(payloadOffset + payloadLength)
    };
  }

  // Extract the AppleWLoc protobuf payload from a /clls/wloc response body.
  // Returns a typed result: { kind, payload, ... } so the caller can write back
  // in the correct format.
  //
  // Supported shapes:
  //   "arpc"      – Full ARPC envelope (same format as requests). The real Apple
  //                 response uses this. Contains arpc metadata for write-back.
  //   "synthetic" – Our own spoofed response: APPLE_WLOC_PREFIX (8 bytes) + uint16 len.
  //   "marker"    – Fallback: marker search 00 00 00 01 00 00 + uint16 len.
  //                 Keeps the prefix/suffix bytes for write-back.
  //   "bare"      – Bare protobuf payload (field tag 0x12 = wifi device, wire type 2).
  function extractAppleWLocPayload(responseBytes) {
    if (!responseBytes || responseBytes.length < 2) {
      throw new Error("Apple WLoc response too short");
    }

    // Shape 1: prefixed WLoc response. The original Go implementation emits
    // 0001000000010000, while Apple's live responses may use 0001000000030000.
    var prefixed = extractPrefixedAppleWLocPayload(responseBytes);
    if (prefixed) {
      return prefixed;
    }

    // Shape 2: ARPC envelope – try the proper structured parser first.
    // The Apple /clls/wloc response uses the same ARPC framing as the request.
    try {
      var arpc = parseArpc(responseBytes);
      if (arpc.payload.length > 0 && tryParseFields(arpc.payload) !== null) {
        return {
          kind: "arpc",
          payload: arpc.payload,
          arpc: arpc
        };
      }
    } catch (e) {
      // ARPC parse failed – continue with fallback strategies.
    }

    // Shape 3: marker search fallback. The ARPC functionId (00 00 00 01) may be
    // followed by uint16/uint32 payload length. Try to find and validate.
    var markerIdx = findBytes(responseBytes, APPLE_WLOC_MARKER);
    if (markerIdx >= 0) {
      var lenOffset = markerIdx + APPLE_WLOC_MARKER.length;
      if (lenOffset + 2 <= responseBytes.length) {
        var realLen = readUInt16BE(responseBytes, lenOffset);
        var realPayloadOffset = lenOffset + 2;
        if (realLen > 0 && realPayloadOffset + realLen <= responseBytes.length) {
          var candidatePayload = responseBytes.slice(realPayloadOffset, realPayloadOffset + realLen);
          // Only accept if the candidate parses as valid protobuf.
          if (tryParseFields(candidatePayload) !== null) {
            return {
              kind: "marker",
              payload: candidatePayload,
              prefix: responseBytes.slice(0, markerIdx),
              markerAndLen: responseBytes.slice(markerIdx, realPayloadOffset),
              suffix: responseBytes.slice(realPayloadOffset + realLen)
            };
          }
        }
      }
    }

    // Shape 4: bare protobuf payload (best effort).
    if (looksLikeAppleWLocPayload(responseBytes)) {
      return {
        kind: "bare",
        payload: responseBytes
      };
    }

    throw new Error("missing Apple WLoc response prefix");
  }

  // Heuristic: a valid AppleWLoc payload starts with a protobuf tag whose wire type
  // is 0 or 2 and field number is > 0. Field 2 (wifi) tag is 0x12.
  function looksLikeAppleWLocPayload(bytes) {
    if (!bytes || bytes.length === 0) {
      return false;
    }
    var tag = bytes[0];
    var fieldNumber = tag >> 3;
    var wireType = tag & 0x7;
    return fieldNumber > 0 && (wireType === 0 || wireType === 2);
  }

  function spoofArpcRequest(requestBytes, configInput) {
    var config = normalizeConfig(configInput);
    var arpc = parseArpc(requestBytes);
    var patched = patchAppleWLocPayload(arpc.payload, config);
    return {
      response: buildAppleWLocResponse(patched.payload),
      payload: patched.payload,
      wifiCount: patched.wifiCount,
      cellCount: patched.cellCount,
      arpc: arpc
    };
  }

  function spoofAppleResponse(responseBytes, configInput) {
    var config = normalizeConfig(configInput);
    var extraction = extractAppleWLocPayload(responseBytes);
    var patched = patchAppleWLocPayload(extraction.payload, config);
    var response;

    if (extraction.kind === "arpc") {
      // Write back in ARPC format, preserving the original envelope metadata.
      var arpcOut = {
        version: extraction.arpc.version,
        locale: extraction.arpc.locale,
        appIdentifier: extraction.arpc.appIdentifier,
        osVersion: extraction.arpc.osVersion,
        functionId: extraction.arpc.functionId,
        payload: patched.payload
      };
      response = serializeArpc(arpcOut);
    } else if (extraction.kind === "marker") {
      // Rebuild: original prefix + marker bytes + new uint16 len + patched payload + suffix.
      var newLenBytes = writeUInt16BE(patched.payload.length);
      response = concatBytes([
        extraction.prefix,
        extraction.markerAndLen.slice(0, APPLE_WLOC_MARKER.length),
        newLenBytes,
        patched.payload,
        extraction.suffix
      ]);
    } else {
      // synthetic / bare – use the simple prefix format.
      response = buildAppleWLocResponse(patched.payload, extraction.prefix);
    }

    return {
      response: response,
      payload: patched.payload,
      wifiCount: patched.wifiCount,
      cellCount: patched.cellCount,
      kind: extraction.kind,
      prefix: extraction.prefix ? hexPreview(extraction.prefix, 8) : ""
    };
  }

  function parseArgumentString(argument) {
    var result = {};
    if (!argument || typeof argument !== "string") {
      return result;
    }

    var tailKeys = [
      "debug",
      "mode",
      "enabled",
      "latitude",
      "longitude",
      "altitude",
      "address",
      "configHost",
      "configToken",
      "horizontalAccuracy",
      "verticalAccuracy",
      "unknownValue4",
      "motionActivityType",
      "motionActivityConfidence",
      "failOpen",
      "dumpRaw",
      "dumpHeaders",
      "prepareHeaders",
      "rawLimit"
    ];
    var configUrlKey = "configUrl=";
    var configUrlIdx = argument.indexOf(configUrlKey);
    if (configUrlIdx >= 0) {
      var valueStart = configUrlIdx + configUrlKey.length;
      var tail = argument.slice(valueStart);
      var end = -1;
      var i;
      for (i = 0; i < tailKeys.length; i += 1) {
        var marker = "&" + tailKeys[i] + "=";
        var pos = tail.indexOf(marker);
        if (pos >= 0 && (end < 0 || pos < end)) {
          end = pos;
        }
      }
      var configUrlValue = end >= 0 ? tail.slice(0, end) : tail;
      try {
        result.configUrl = decodeURIComponent(configUrlValue);
      } catch (err) {
        result.configUrl = configUrlValue;
      }
      argument = argument.slice(0, configUrlIdx) + (end >= 0 ? tail.slice(end + 1) : "");
    }

    var pairs = argument.split(/[&;]/);
    for (var j = 0; j < pairs.length; j += 1) {
      var part = pairs[j];
      if (!part) {
        continue;
      }
      var eq = part.indexOf("=");
      var key = eq >= 0 ? part.slice(0, eq) : part;
      var value = eq >= 0 ? part.slice(eq + 1) : "true";
      try {
        result[decodeURIComponent(key)] = decodeURIComponent(value);
      } catch (err2) {
        result[key] = value;
      }
    }
    return result;
  }

  function resolveConfigUrl(args) {
    args = args || {};
    var direct = String(args.configUrl || args.cfg || args.url || "").trim();
    if (direct) {
      return direct;
    }
    var host = String(args.configHost || "").trim().replace(/\/+$/, "");
    var token = String(args.configToken || "").trim();
    if (host && token) {
      return host + "/loc.json?token=" + encodeURIComponent(token);
    }
    return "";
  }

  function isPlaceholderValue(value) {
    return typeof value === "string" && /^\{[^}]+\}$/.test(value.trim());
  }

  function readPluginStoreArg(name) {
    if (typeof $persistentStore === "undefined" || !$persistentStore.read) {
      return null;
    }
    try {
      var value = $persistentStore.read(name);
      if (value == null || value === "") {
        return null;
      }
      return String(value);
    } catch (err) {
      return null;
    }
  }

  function enrichArgsFromPluginStore(args) {
    var keys = [
      "enabled",
      "latitude",
      "longitude",
      "altitude",
      "address",
      "configHost",
      "configToken",
      "configUrl",
      "debug"
    ];
    var i;
    args = args || {};
    for (i = 0; i < keys.length; i += 1) {
      var key = keys[i];
      var current = args[key];
      if (current == null || current === "" || isPlaceholderValue(current)) {
        var stored = readPluginStoreArg(key);
        if (stored != null && !isPlaceholderValue(stored)) {
          args[key] = stored;
        }
      }
    }
    return args;
  }

  function readScriptArguments() {
    var out = {};
    if (typeof $argument !== "undefined" && $argument != null) {
      if (typeof $argument === "string") {
        out = parseArgumentString($argument);
      } else if (typeof $argument === "object") {
        var key;
        for (key in $argument) {
          if (Object.prototype.hasOwnProperty.call($argument, key)) {
            var value = $argument[key];
            out[key] = value == null ? "" : String(value);
          }
        }
      } else {
        out = parseArgumentString(String($argument));
      }
    }
    return enrichArgsFromPluginStore(out);
  }

  function logScriptArguments(debug) {
    if (!debug) {
      return;
    }
    var args = readScriptArguments();
    var raw =
      typeof $argument === "undefined" || $argument == null
        ? "<none>"
        : typeof $argument === "object"
          ? JSON.stringify($argument)
          : String($argument);
    console.log("Location spoofer $argument raw: " + raw);
    console.log(
      "Location spoofer args parsed: lat=" +
        args.latitude +
        ", lng=" +
        args.longitude +
        ", configUrl=" +
        (resolveConfigUrl(args) || "<none>")
    );
  }

  function detectRuntime() {
    if (typeof $environment !== "undefined" && $environment && $environment.product) {
      return String($environment.product);
    }
    if (typeof $loon !== "undefined") {
      return "Loon";
    }
    return "Unknown";
  }

  function isLoonRuntime() {
    return detectRuntime() === "Loon";
  }

  function isGzipBytes(bytes) {
    return bytes && bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  }

  function readGeocodeCache() {
    if (typeof $persistentStore === "undefined" || !$persistentStore.read) {
      return null;
    }
    try {
      var raw = $persistentStore.read("location_spoofer_geocode");
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      return null;
    }
  }

  function writeGeocodeCache(entry) {
    if (typeof $persistentStore === "undefined" || !$persistentStore.write) {
      return;
    }
    try {
      $persistentStore.write("location_spoofer_geocode", JSON.stringify(entry));
    } catch (err) {
      // ignore cache write failures
    }
  }

  function fetchElevation(lat, lng, callback) {
    if (typeof $httpClient === "undefined" || !$httpClient.get) {
      callback(null);
      return;
    }
    var url =
      "https://api.open-meteo.com/v1/elevation?latitude=" +
      encodeURIComponent(String(lat)) +
      "&longitude=" +
      encodeURIComponent(String(lng));
    $httpClient.get({ url: url, timeout: 4000 }, function (error, response, body) {
      if (error || !body) {
        callback(null);
        return;
      }
      try {
        var data = JSON.parse(body);
        if (data && data.elevation && data.elevation.length) {
          callback(Math.round(Number(data.elevation[0])));
          return;
        }
      } catch (err) {
        // ignore parse failures
      }
      callback(null);
    });
  }

  function geocodeAddress(address, debug, callback) {
    var query = String(address || "").trim();
    if (!query) {
      callback(null);
      return;
    }

    var cached = readGeocodeCache();
    if (cached && cached.address === query && Number.isFinite(Number(cached.latitude)) && Number.isFinite(Number(cached.longitude))) {
      if (debug) {
        console.log("Location spoofer geocode cache hit: " + query + " -> " + cached.latitude + "," + cached.longitude);
      }
      callback(cached);
      return;
    }

    if (typeof $httpClient === "undefined" || !$httpClient.get) {
      if (debug) {
        console.log("Location spoofer geocode skipped: $httpClient unavailable");
      }
      callback(null);
      return;
    }

    var url =
      "https://nominatim.openstreetmap.org/search?format=json&limit=1&addressdetails=0&q=" +
      encodeURIComponent(query);
    $httpClient.get(
      {
        url: url,
        timeout: 8000,
        headers: { "User-Agent": "ios-location-spoofer/1.0 (Loon plugin)" }
      },
      function (error, response, body) {
        if (error || !body) {
          if (debug) {
            console.log("Location spoofer geocode failed: " + (error || "empty body"));
          }
          callback(null);
          return;
        }
        try {
          var results = JSON.parse(body);
          if (!results || !results.length) {
            if (debug) {
              console.log("Location spoofer geocode no result for: " + query);
            }
            callback(null);
            return;
          }
          var hit = results[0];
          var lat = Number(hit.lat);
          var lng = Number(hit.lon);
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            callback(null);
            return;
          }
          var entry = {
            address: query,
            latitude: lat,
            longitude: lng,
            displayName: hit.display_name || query
          };
          fetchElevation(lat, lng, function (altitude) {
            if (altitude != null) {
              entry.altitude = altitude;
            }
            writeGeocodeCache(entry);
            if (debug) {
              console.log(
                "Location spoofer geocode resolved: " +
                  query +
                  " -> " +
                  lat +
                  "," +
                  lng +
                  (altitude != null ? ", alt=" + altitude : "")
              );
            }
            callback(entry);
          });
        } catch (err) {
          if (debug) {
            console.log("Location spoofer geocode parse failed: " + err.message);
          }
          callback(null);
        }
      }
    );
  }

  function mergeConfig(base, extra) {
    var out = {};
    var key;
    for (key in base) {
      if (Object.prototype.hasOwnProperty.call(base, key)) {
        out[key] = base[key];
      }
    }
    extra = extra || {};
    for (key in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, key)) {
        out[key] = extra[key];
      }
    }
    return out;
  }

  function decodeBase64(value) {
    if (typeof atob === "function") {
      return atob(value);
    }
    if (typeof Buffer !== "undefined") {
      return Buffer.from(value, "base64").toString("utf8");
    }
    throw new Error("base64 decoder unavailable");
  }

  function configFromArgs(args) {
    var cfg = {};
    var scalarKeys = [
      "enabled",
      "mode",
      "latitude",
      "longitude",
      "address",
      "horizontalAccuracy",
      "verticalAccuracy",
      "altitude",
      "unknownValue4",
      "motionActivityType",
      "motionActivityConfidence",
      "failOpen",
      "debug",
      "dumpRaw",
      "dumpHeaders",
      "prepareHeaders",
      "rawLimit"
    ];

    if (args.config) {
      cfg = mergeConfig(cfg, JSON.parse(args.config));
    }
    if (args.configBase64) {
      cfg = mergeConfig(cfg, JSON.parse(decodeBase64(args.configBase64)));
    }
    for (var i = 0; i < scalarKeys.length; i += 1) {
      var key = scalarKeys[i];
      if (Object.prototype.hasOwnProperty.call(args, key)) {
        cfg[key] = args[key];
      }
    }
    return cfg;
  }

  function readRemoteConfigCache(url) {
    if (!url || typeof $persistentStore === "undefined" || !$persistentStore.read) {
      return null;
    }
    try {
      var raw = $persistentStore.read("location_spoofer_remote_cfg");
      if (!raw) {
        return null;
      }
      var entry = JSON.parse(raw);
      if (!entry || entry.url !== url || !entry.data) {
        return null;
      }
      if (Date.now() - entry.ts > 300000) {
        return null;
      }
      return entry.data;
    } catch (err) {
      return null;
    }
  }

  function writeRemoteConfigCache(url, data) {
    if (!url || typeof $persistentStore === "undefined" || !$persistentStore.write) {
      return;
    }
    try {
      $persistentStore.write(
        "location_spoofer_remote_cfg",
        JSON.stringify({ url: url, data: data, ts: Date.now() })
      );
    } catch (err) {
      // ignore cache write failures
    }
  }

  function fetchRemoteConfig(url, timeout, debug, callback) {
    if (!url || typeof $httpClient === "undefined" || !$httpClient.get) {
      callback(null, "http client unavailable");
      return;
    }
    $httpClient.get({ url: url, timeout: timeout || 3000 }, function (error, response, body) {
      if (error || !body) {
        callback(null, error || "empty body");
        return;
      }
      try {
        callback(JSON.parse(body), null);
      } catch (err) {
        callback(null, err.message);
      }
    });
  }

  function refreshRemoteConfigCache(url, debug) {
    fetchRemoteConfig(url, 5000, debug, function (data, err) {
      if (data) {
        writeRemoteConfigCache(url, data);
        return;
      }
      if (debug) {
        console.log("Location spoofer remote config refresh failed: " + err);
      }
    });
  }

  function applyAddressFromCache(cfg, address, debug) {
    if (!address) {
      return;
    }
    var cached = readGeocodeCache();
    if (cached && cached.address === address && Number.isFinite(Number(cached.latitude)) && Number.isFinite(Number(cached.longitude))) {
      cfg.latitude = cached.latitude;
      cfg.longitude = cached.longitude;
      if (cached.altitude != null) {
        cfg.altitude = cached.altitude;
      }
      if (debug) {
        console.log("Location spoofer geocode cache hit: " + address);
      }
      return;
    }
    if (debug) {
      console.log("Location spoofer geocode cache miss: " + address + " (use manual lat/lng until cron refreshes)");
    }
  }

  function loadRuntimeConfigSync() {
    var args = readScriptArguments();
    var cfg = mergeConfig(DEFAULT_CONFIG, configFromArgs(args));
    var configUrl = resolveConfigUrl(args);
    var debug = parseBoolean(cfg.debug, false);
    var address = String(args.address || "").trim();

    applyAddressFromCache(cfg, address, debug);

    if (configUrl) {
      var remoteCfg = readRemoteConfigCache(configUrl);
      if (remoteCfg) {
        cfg = mergeConfig(cfg, remoteCfg);
        if (debug) {
          console.log(
            "Location spoofer remote config cache hit -> " +
              remoteCfg.latitude +
              "," +
              remoteCfg.longitude
          );
        }
      }
    }

    return { cfg: cfg, configUrl: configUrl, debug: debug };
  }

  function loadRuntimeConfig(callback) {
    var loaded = loadRuntimeConfigSync();
    var cfg = loaded.cfg;
    var configUrl = loaded.configUrl;
    var debug = loaded.debug;

    function finish() {
      try {
        callback(normalizeConfig(cfg));
      } catch (err) {
        if (debug) {
          console.log("Location spoofer config invalid: " + err.message + " | cfg lat/lng=" + cfg.latitude + "," + cfg.longitude);
        }
        if (!Number.isFinite(Number(cfg.latitude)) || !Number.isFinite(Number(cfg.longitude))) {
          cfg.latitude = DEFAULT_CONFIG.latitude;
          cfg.longitude = DEFAULT_CONFIG.longitude;
        }
        callback(normalizeConfig(cfg));
      }
    }

    logScriptArguments(debug);

    if (!configUrl) {
      finish();
      return;
    }

    if (readRemoteConfigCache(configUrl)) {
      refreshRemoteConfigCache(configUrl, debug);
      finish();
      return;
    }

    if (debug) {
      console.log("Location spoofer remote config fetching: " + configUrl);
    }
    fetchRemoteConfig(configUrl, 3000, debug, function (data, err) {
      if (data) {
        writeRemoteConfigCache(configUrl, data);
        cfg = mergeConfig(cfg, data);
        if (debug) {
          console.log(
            "Location spoofer remote config loaded -> " + data.latitude + "," + data.longitude
          );
        }
      } else if (debug) {
        console.log("Location spoofer remote config fetch failed: " + err + " (using manual lat/lng)");
      }
      finish();
    });
  }

  function runMaintenanceCron() {
    var args = readScriptArguments();
    var debug = parseBoolean(args.debug, false);
    var pending = 0;

    function maybeDone() {
      pending -= 1;
      if (pending <= 0) {
        $done({});
      }
    }

    var configUrl = resolveConfigUrl(args);
    if (configUrl) {
      pending += 1;
      fetchRemoteConfig(configUrl, 8000, debug, function (data, err) {
        if (data) {
          writeRemoteConfigCache(configUrl, data);
          if (debug) {
            console.log(
              "Location spoofer config cron cached -> " + data.latitude + "," + data.longitude
            );
          }
        } else if (debug) {
          console.log("Location spoofer config cron failed: " + err);
        }
        maybeDone();
      });
    }

    var address = String(args.address || "").trim();
    if (address) {
      pending += 1;
      geocodeAddress(address, debug, function () {
        maybeDone();
      });
    }

    if (pending === 0) {
      $done({});
    }
  }

  function runGeocodeCron() {
    runMaintenanceCron();
  }

  function headersWithBinaryBody(sourceHeaders, length) {
    var headers = {};
    var key;
    sourceHeaders = sourceHeaders || {};
    for (key in sourceHeaders) {
      if (Object.prototype.hasOwnProperty.call(sourceHeaders, key)) {
        var lower = key.toLowerCase();
        if (lower !== "content-length" && lower !== "content-encoding" && lower !== "transfer-encoding") {
          headers[key] = sourceHeaders[key];
        }
      }
    }
    headers["Content-Type"] = "application/octet-stream";
    headers["Content-Length"] = String(length);
    return headers;
  }

  function setHeader(headers, name, value) {
    headers = headers || {};
    var lower = name.toLowerCase();
    var existingKey = null;
    for (var key in headers) {
      if (Object.prototype.hasOwnProperty.call(headers, key) && key.toLowerCase() === lower) {
        existingKey = key;
        break;
      }
    }
    headers[existingKey || name] = value;
    return headers;
  }

  function prepareRequestHeaders(headers) {
    return setHeader(headers || {}, "Accept-Encoding", "identity");
  }

  function donePreparedRequestPassThrough() {
    var headers = prepareRequestHeaders((typeof $request !== "undefined" && $request.headers) || {});
    $done({
      headers: headers
    });
  }

  // Decode an HTTP response body that may be gzip/deflate/br encoded.
  // Shadowrocket/Surge expose $utils.ungzip; Loon falls back to DecompressionStream.
  function decompressBody(body, contentEncoding) {
    if (body == null) {
      return body;
    }
    var enc = contentEncoding ? String(contentEncoding).toLowerCase() : "";
    if (enc === "identity" || enc === "") {
      return body;
    }
    try {
      if (enc.indexOf("gzip") >= 0 && typeof $utils !== "undefined" && $utils.ungzip) {
        return $utils.ungzip(body);
      }
      if (enc.indexOf("deflate") >= 0 && typeof $utils !== "undefined" && $utils.inflate) {
        return $utils.inflate(body);
      }
      if (enc.indexOf("br") >= 0 && typeof $utils !== "undefined" && $utils.brotliDecompress) {
        return $utils.brotliDecompress(body);
      }
    } catch (err) {
      if (typeof console !== "undefined") {
        console.log("Location spoofer decompress failed (" + enc + "): " + err.message);
      }
    }
    return body;
  }

  function prepareResponseBodySync(config) {
    var respHeaders = ($response && $response.headers) || {};
    var contentEncoding = headerValue(respHeaders, "Content-Encoding");
    var rawRespBody = $response && ($response.body != null ? $response.body : $response.bodyBytes);
    logHttpDump("response-wire-original", $response, config);
    logRawDump("response-wire-original", bodyToBytes(rawRespBody), config);

    var bytes = bodyToBytes(rawRespBody);
    if (!bytes || bytes.length < 2) {
      return;
    }

    if (isGzipBytes(bytes) || (contentEncoding && String(contentEncoding).toLowerCase().indexOf("gzip") >= 0)) {
      var decoded = bodyToBytes(decompressBody(rawRespBody, contentEncoding || "gzip"));
      if (decoded && decoded.length > 2 && !isGzipBytes(decoded)) {
        $response.body = decoded;
        if (config.debug) {
          console.log("Location spoofer decompressed body: " + bytes.length + " -> " + decoded.length + " bytes");
        }
        return;
      }
      if (config.debug) {
        console.log(
          "Location spoofer gzip body still compressed (len=" +
            bytes.length +
            "); ensure http-request prepare script is enabled"
        );
      }
      return;
    }

    if (contentEncoding) {
      var plain = bodyToBytes(decompressBody(rawRespBody, contentEncoding));
      if (plain) {
        $response.body = plain;
      }
    }
  }

  function headerValue(headers, name) {
    if (!headers) {
      return undefined;
    }
    var lower = name.toLowerCase();
    for (var key in headers) {
      if (Object.prototype.hasOwnProperty.call(headers, key) && key.toLowerCase() === lower) {
        return headers[key];
      }
    }
    return undefined;
  }

  function donePassThrough() {
    $done({});
  }

  function valueType(value) {
    if (value == null) {
      return String(value);
    }
    if (value instanceof Uint8Array) {
      return "Uint8Array";
    }
    if (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer) {
      return "ArrayBuffer";
    }
    return typeof value;
  }

  function valueLength(value) {
    if (value == null) {
      return 0;
    }
    if (typeof value === "string" || typeof value.length === "number") {
      return value.length;
    }
    if (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer) {
      return value.byteLength;
    }
    return 0;
  }

  function objectKeys(value) {
    if (!value || typeof value !== "object") {
      return "";
    }
    var keys = [];
    for (var key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        keys.push(key);
      }
    }
    return keys.join(",");
  }

  function fieldHistogram(fields) {
    var counts = {};
    var order = [];
    for (var i = 0; i < fields.length; i += 1) {
      var key = String(fields[i].fieldNumber) + "/" + String(fields[i].wireType);
      if (!counts[key]) {
        counts[key] = 0;
        order.push(key);
      }
      counts[key] += 1;
    }
    var parts = [];
    for (var j = 0; j < order.length; j += 1) {
      parts.push(order[j] + "x" + counts[order[j]]);
    }
    return parts.join(",");
  }

  function countFields(fields, fieldNumber) {
    var count = 0;
    for (var i = 0; i < fields.length; i += 1) {
      if (fields[i].fieldNumber === fieldNumber) {
        count += 1;
      }
    }
    return count;
  }

  function countCellResponseFields(fields) {
    var count = 0;
    for (var i = 0; i < fields.length; i += 1) {
      if (isCellResponseField(fields[i].fieldNumber)) {
        count += 1;
      }
    }
    return count;
  }

  function appleWLocPayloadInspect(payload) {
    try {
      var fields = parseFields(payload);
      var parts = [
        "payloadLen=" + payload.length,
        "fields=" + fieldHistogram(fields),
        "wifi=" + countFields(fields, 2),
        "cellResp=" + countCellResponseFields(fields),
        "cellReq=" + countFields(fields, 25),
        "hasCounts=" + (countFields(fields, 3) + "/" + countFields(fields, 4)),
        "deviceType=" + countFields(fields, 33),
        patchedPayloadSummary(payload)
      ];
      return parts.join(", ");
    } catch (err) {
      return "payload parse failed: " + err.message;
    }
  }

  function logRawDump(label, bytes, config) {
    if (!config.dumpRaw || !bytes) {
      return;
    }
    var limit = config.rawLimit || 0;
    var emitted = limit > 0 && bytes.length > limit ? bytes.slice(0, limit) : bytes;
    var encoded = bytesToBase64(emitted);
    var chunkSize = 3000;
    var chunks = Math.max(1, Math.ceil(encoded.length / chunkSize));
    console.log("Location spoofer raw " + label + " base64 begin: len=" + bytes.length + ", emitted=" + emitted.length + ", chunks=" + chunks + ", truncated=" + (emitted.length !== bytes.length));
    for (var i = 0; i < encoded.length; i += chunkSize) {
      var chunkIndex = Math.floor(i / chunkSize) + 1;
      console.log("Location spoofer raw " + label + " base64 chunk " + chunkIndex + "/" + chunks + ": " + encoded.slice(i, i + chunkSize));
    }
    console.log("Location spoofer raw " + label + " base64 end");
  }

  function jsonString(value) {
    try {
      return JSON.stringify(value || {});
    } catch (err) {
      return "<json-failed:" + err.message + ">";
    }
  }

  function logHttpDump(label, message, config) {
    if (!config.dumpHeaders && !config.dumpRaw) {
      return;
    }
    message = message || {};
    var request = typeof $request !== "undefined" ? $request : {};
    var method = message.method || request.method || "<none>";
    var url = message.url || request.url || "<none>";
    var status = message.status || message.statusCode || "<none>";
    console.log("Location spoofer raw " + label + " meta: method=" + method + ", url=" + url + ", status=" + status);
    if (config.dumpHeaders) {
      console.log("Location spoofer raw " + label + " headers: " + jsonString(message.headers || {}));
    }
  }

  function inspectResponseBytes(bytes, config) {
    if (!bytes) {
      console.log("Location spoofer inspect response body unavailable");
      return;
    }
    console.log("Location spoofer inspect response body: len=" + bytes.length + ", head=" + hexPreview(bytes, 48));
    logRawDump("response", bytes, config);
    try {
      var extraction = extractAppleWLocPayload(bytes);
      console.log("Location spoofer inspect response extraction: kind=" + extraction.kind + ", prefix=" + (extraction.prefix ? hexPreview(extraction.prefix, 8) : "<none>") + ", payloadLen=" + extraction.payload.length + ", suffixLen=" + (extraction.suffix ? extraction.suffix.length : 0));
      console.log("Location spoofer inspect response payload: " + appleWLocPayloadInspect(extraction.payload));
    } catch (err) {
      console.log("Location spoofer inspect response extraction failed: " + err.message);
      var directFields = tryParseFields(bytes);
      if (directFields) {
        console.log("Location spoofer inspect response direct fields: " + fieldHistogram(directFields));
      }
    }
  }

  function inspectRequestBytes(bytes, config) {
    if (!bytes) {
      console.log("Location spoofer inspect request body unavailable");
      return;
    }
    console.log("Location spoofer inspect request body: len=" + bytes.length + ", head=" + hexPreview(bytes, 48));
    logRawDump("request", bytes, config);
    try {
      var arpc = parseArpc(bytes);
      console.log("Location spoofer inspect request arpc: version=" + arpc.version + ", functionId=" + arpc.functionId + ", locale=" + arpc.locale + ", app=" + arpc.appIdentifier + ", os=" + arpc.osVersion + ", payloadLen=" + arpc.payload.length);
      console.log("Location spoofer inspect request payload: " + appleWLocPayloadInspect(arpc.payload));
    } catch (err) {
      console.log("Location spoofer inspect request arpc failed: " + err.message);
      var directFields = tryParseFields(bytes);
      if (directFields) {
        console.log("Location spoofer inspect request direct fields: " + fieldHistogram(directFields));
      }
    }
  }

  function doneInspect(config, hasResponse) {
    if (hasResponse) {
      logHttpDump("response", $response, config);
      inspectResponseBytes(messageBodyToBytes($response), config);
    } else {
      logHttpDump("request", $request, config);
      inspectRequestBytes(messageBodyToBytes($request), config);
      if (config.prepareHeaders) {
        donePreparedRequestPassThrough();
        return;
      }
    }
    donePassThrough();
  }

  function doneResponseProbe(config) {
    var response = typeof $response !== "undefined" ? $response : {};
    var headers = response.headers || {};
    if (config.debug) {
      console.log("Location spoofer probe response keys: " + objectKeys(response));
      console.log("Location spoofer probe headers: status=" + (response.status || response.statusCode || "<none>") + ", content-length=" + (headerValue(headers, "Content-Length") || "<none>") + ", content-type=" + (headerValue(headers, "Content-Type") || "<none>") + ", content-encoding=" + (headerValue(headers, "Content-Encoding") || "none"));
      console.log("Location spoofer probe body slots: body=" + valueType(response.body) + "/" + valueLength(response.body) + ", bodyBytes=" + valueType(response.bodyBytes) + "/" + valueLength(response.bodyBytes) + ", rawBody=" + valueType(response.rawBody) + "/" + valueLength(response.rawBody) + ", binaryBody=" + valueType(response.binaryBody) + "/" + valueLength(response.binaryBody));
      var bytes = messageBodyToBytes(response);
      console.log("Location spoofer probe selected body: " + (bytes ? bytes.length : 0) + " bytes, head=" + (bytes ? hexPreview(bytes, 32) : "<none>"));
    }
    donePassThrough();
  }

  function doneSyntheticResponse(bytes, info) {
    var headers = headersWithBinaryBody({}, bytes.length);
    if (info && info.debug) {
      headers["X-Location-Spoofer-Wifi-Count"] = String(info.wifiCount);
      headers["X-Location-Spoofer-Cell-Count"] = String(info.cellCount || 0);
    }
    if (isLoonRuntime()) {
      $done({
        status: 200,
        headers: headers,
        body: bytes
      });
      return;
    }
    $done({
      response: {
        status: 200,
        headers: headers,
        body: bytes
      }
    });
  }

  function doneRewriteResponse(bytes, info) {
    var sourceHeaders = typeof $response !== "undefined" ? $response.headers : {};
    var headers = headersWithBinaryBody(sourceHeaders, bytes.length);
    if (info && info.debug) {
      headers["X-Location-Spoofer-Wifi-Count"] = String(info.wifiCount);
      headers["X-Location-Spoofer-Cell-Count"] = String(info.cellCount || 0);
    }
    if (info && info.targetLat != null && info.targetLng != null) {
      headers["X-Location-Spoofer-Target"] = String(info.targetLat) + "," + String(info.targetLng);
    }
    if (isLoonRuntime()) {
      $done({
        status: ($response && $response.status) || 200,
        headers: headers,
        body: bytes
      });
      return;
    }
    $done({
      headers: headers,
      body: bytes
    });
  }

  function continueResponseRewrite(config) {
    var responseBody = messageBodyToBytes($response);
    if (!responseBody || responseBody.length < 2) {
      if (config.debug) {
        console.log(
          "Location spoofer response body too short: " +
            (responseBody ? responseBody.length : 0) +
            " bytes, head=" +
            (responseBody ? hexPreview(responseBody) : "<none>")
        );
      }
      donePassThrough();
      return;
    }
    if (config.debug) {
      console.log("Location spoofer response body: " + responseBody.length + " bytes, head=" + hexPreview(responseBody, 32));
      if (isLoonRuntime()) {
        console.log("Location spoofer runtime: Loon");
      }
    }
    logHttpDump("response-original", $response, config);
    logRawDump("response-original", responseBody, config);
    var responseResult = spoofAppleResponse(responseBody, config);
    if (config.debug) {
      console.log(
        "Location spoofer patched " +
          responseResult.wifiCount +
          " wifi devices, " +
          responseResult.cellCount +
          " cell towers, kind=" +
          responseResult.kind +
          ", prefix=" +
          (responseResult.prefix || "<none>") +
          ", response=" +
          responseResult.response.length +
          " bytes"
      );
      console.log("Location spoofer patched locations: " + patchedPayloadSummary(responseResult.payload));
    }
    logRawDump("response-patched", responseResult.response, config);
    doneRewriteResponse(responseResult.response, {
      wifiCount: responseResult.wifiCount,
      cellCount: responseResult.cellCount,
      debug: config.debug,
      targetLat: config.latitude,
      targetLng: config.longitude
    });
  }

  function prepareResponseBody(config) {
    prepareResponseBodySync(config);
  }

  function runShadowrocket() {
    var hasRequest = typeof $request !== "undefined" && $request != null;
    var hasResponse = typeof $response !== "undefined" && $response != null;

    if (!hasRequest && !hasResponse) {
      runMaintenanceCron();
      return;
    }

    if (hasRequest && !hasResponse) {
      var prepArgs = readScriptArguments();
      if (parseBoolean(prepArgs.debug, false)) {
        console.log("Location spoofer prepare -> Accept-Encoding: identity");
      }
      donePreparedRequestPassThrough();
      return;
    }

    loadRuntimeConfig(function (config) {
      try {
        if (!config.enabled) {
          donePassThrough();
          return;
        }

        if (config.mode === "inspect") {
          doneInspect(config, hasResponse);
          return;
        }

        if (hasResponse) {
          if (config.debug) {
            console.log(
              "Location spoofer intercept -> lat=" +
                config.latitude +
                ", lng=" +
                config.longitude +
                ", url=" +
                (($request && $request.url) || "<none>")
            );
          }
          if (config.mode === "probe") {
            doneResponseProbe(config);
            return;
          }
          if (config.mode !== "response") {
            donePassThrough();
            return;
          }
          prepareResponseBody(config);
          continueResponseRewrite(config);
          return;
        }

        if (config.mode !== "request") {
          donePassThrough();
          return;
        }
        var requestBody = messageBodyToBytes($request);
        if (config.debug) {
          console.log("Location spoofer request mode body length: " + (requestBody ? requestBody.length : 0));
        }
        if (!requestBody) {
          if (config.debug) {
            console.log("Location spoofer request body unavailable");
          }
          donePassThrough();
          return;
        }
        if (requestBody.length < 2) {
          if (config.debug) {
            console.log("Location spoofer request body too short: " + requestBody.length + " bytes, head=" + hexPreview(requestBody));
          }
          donePassThrough();
          return;
        }
        logHttpDump("request-original", $request, config);
        logRawDump("request-original", requestBody, config);
        var requestResult = spoofArpcRequest(requestBody, config);
        if (config.debug) {
          console.log("Location spoofer request synthetic response: patched " + requestResult.wifiCount + " wifi devices, " + requestResult.cellCount + " cell towers, response=" + requestResult.response.length + " bytes");
          console.log("Location spoofer patched locations: " + patchedPayloadSummary(requestResult.payload));
        }
        logRawDump("request-synthetic-response", requestResult.response, config);
        doneSyntheticResponse(requestResult.response, {
          wifiCount: requestResult.wifiCount,
          cellCount: requestResult.cellCount,
          debug: config.debug
        });
      } catch (err) {
        if (config.debug) {
          var diagBody = hasResponse ? messageBodyToBytes($response) : messageBodyToBytes($request);
          console.log("Location spoofer failed: " + err.message + " | bodyLen=" + (diagBody ? diagBody.length : 0) + " head=" + (diagBody ? hexPreview(diagBody, 32) : "<none>"));
        }
        if (config.failOpen !== false) {
          donePassThrough();
          return;
        }
        $done({
          response: {
            status: "HTTP/1.1 500 Internal Server Error",
            headers: { "Content-Type": "text/plain" },
            body: "location spoofer failed: " + err.message
          }
        });
      }
    });
  }

  // ============================================================
  // SurgeLoc 附加層:動態座標(persistentStore)+ 控制台網頁 + HTTP API
  // 引擎:攔 wloc 回應覆蓋(Wi-Fi 熱點 + 基地台座標,多格式)
  // ============================================================
  var SURGELOC_KEY = "SURGELOC_DATA";
  var SURGELOC_CONFIG_HOST = "loc.config";
  var SURGELOC_DEFAULT = { lat: 25.033964, lon: 121.564468 };

  function surgelocSaved() {
    var raw = null;
    try { raw = $persistentStore.read(SURGELOC_KEY); } catch (e) {}
    var o;
    try { o = JSON.parse(raw || JSON.stringify(SURGELOC_DEFAULT)); } catch (e) { o = SURGELOC_DEFAULT; }
    var lon = Number(o.lon);
    while (lon > 180) lon -= 360;
    while (lon < -180) lon += 360;
    // off:true = 已按「恢復真實定位」,引擎放行不覆蓋(仍保留最後座標供下次使用)
    return { lat: Number(o.lat), lon: lon, off: o.off === true };
  }

  // 寫入座標 → 同時開啟模擬(off:false)
  function surgelocWrite(lat, lon) {
    while (lon > 180) lon -= 360;
    while (lon < -180) lon += 360;
    $persistentStore.write(JSON.stringify({ lat: lat, lon: lon, off: false }), SURGELOC_KEY);
  }

  // 只切換開關(保留最後座標);off=true → 恢復真實定位
  function surgelocSetOff(off) {
    var c = surgelocSaved();
    $persistentStore.write(JSON.stringify({ lat: c.lat, lon: c.lon, off: off === true }), SURGELOC_KEY);
  }

  // ---------- 座標收藏(多層樹狀分類:path 以 "/" 分隔)----------
  var SURGELOC_FAV_KEY = "SURGELOC_FAV";
  var SURGELOC_CAT_KEY = "SURGELOC_CATS";

  // 正規化分類路徑:去空白、壓斜線、每段限長
  function surgelocPathNorm(p) {
    var segs = String(p == null ? "" : p).split("/").map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length; }).map(function (s) { return s.slice(0, 40); });
    return segs.join("/");
  }

  function surgelocFavAll() {
    var raw = null;
    try { raw = $persistentStore.read(SURGELOC_FAV_KEY); } catch (e) {}
    var a;
    try { a = JSON.parse(raw || "[]"); } catch (e) { a = []; }
    if (!Array.isArray(a)) a = [];
    return a.map(function (x) {
      // 舊資料相容:cat → path
      var path = x.path != null ? x.path : (x.cat != null ? x.cat : "");
      return {
        id: String(x.id || ""),
        path: surgelocPathNorm(path),
        place: String(x.place || ""),
        lat: Number(x.lat),
        lon: Number(x.lon),
        movedAt: Number(x.movedAt) || 0   // 最後一次「移動到此」的時間戳(供近期上色)
      };
    }).filter(function (x) { return !isNaN(x.lat) && !isNaN(x.lon); });
  }

  // 標記某收藏「剛移動到」(更新時間戳)
  function surgelocFavMarkMoved(id) {
    var list = surgelocFavAll();
    for (var i = 0; i < list.length; i++) { if (list[i].id === String(id)) list[i].movedAt = Date.now(); }
    surgelocFavWrite(list);
  }

  function surgelocFavWrite(list) {
    $persistentStore.write(JSON.stringify(list), SURGELOC_FAV_KEY);
  }

  function surgelocCatRaw() {
    var raw = [];
    try { raw = JSON.parse($persistentStore.read(SURGELOC_CAT_KEY) || "[]"); } catch (e) {}
    return Array.isArray(raw) ? raw : [];
  }
  function surgelocCatWriteRaw(list) { $persistentStore.write(JSON.stringify(list), SURGELOC_CAT_KEY); }

  // 所有分類路徑(含空分類、含所有祖先),依建立順序去重
  function surgelocCatsAll() {
    var set = {}, order = [];
    function add(p) {
      p = surgelocPathNorm(p);
      if (!p) return;
      var segs = p.split("/"), cur = "";
      for (var i = 0; i < segs.length; i++) { cur = cur ? cur + "/" + segs[i] : segs[i]; if (!set[cur]) { set[cur] = 1; order.push(cur); } }
    }
    surgelocCatRaw().forEach(add);
    surgelocFavAll().forEach(function (f) { if (f.path) add(f.path); });
    return order;
  }

  function surgelocCatAdd(path) {
    var p = surgelocPathNorm(path);
    if (p) { var raw = surgelocCatRaw(); if (raw.indexOf(p) === -1) { raw.push(p); surgelocCatWriteRaw(raw); } }
    return surgelocCatsAll();
  }

  // 分類改名(含子分類):把 from 及 from/* 的前綴換成 to
  function surgelocCatRename(from, to) {
    var f = surgelocPathNorm(from), t = surgelocPathNorm(to);
    if (!f || !t) return;
    var favs = surgelocFavAll();
    favs.forEach(function (x) {
      if (x.path === f) x.path = t;
      else if (x.path.indexOf(f + "/") === 0) x.path = t + "/" + x.path.slice(f.length + 1);
    });
    surgelocFavWrite(favs);
    surgelocCatWriteRaw(surgelocCatRaw().map(function (p) {
      p = surgelocPathNorm(p);
      if (p === f) return t;
      if (p.indexOf(f + "/") === 0) return t + "/" + p.slice(f.length + 1);
      return p;
    }));
  }

  // 刪除分類:連同子分類與其中所有收藏一併移除
  function surgelocCatDel(path) {
    var p = surgelocPathNorm(path);
    if (!p) return;
    surgelocFavWrite(surgelocFavAll().filter(function (x) { return !(x.path === p || x.path.indexOf(p + "/") === 0); }));
    surgelocCatWriteRaw(surgelocCatRaw().filter(function (q) { q = surgelocPathNorm(q); return !(q === p || q.indexOf(p + "/") === 0); }));
  }

  function surgelocFavAdd(lat, lon, path, place) {
    var coord = surgelocMk(lat, lon);
    if (!coord) return null;
    var list = surgelocFavAll();
    var item = {
      id: String(Date.now()) + String(Math.floor(Math.random() * 1000)),
      path: surgelocPathNorm(path),
      place: String(place || "").slice(0, 80),
      lat: coord.lat,
      lon: coord.lon
    };
    list.push(item);
    surgelocFavWrite(list);
    return item;
  }

  function surgelocFavDel(id) {
    var list = surgelocFavAll().filter(function (x) { return x.id !== String(id); });
    surgelocFavWrite(list);
    return list;
  }

  function surgelocFavFind(id) {
    var list = surgelocFavAll();
    for (var i = 0; i < list.length; i++) { if (list[i].id === String(id)) return list[i]; }
    return null;
  }

  // 拖曳移動/排序:改 path,並(可選)插到 beforeId 之前;beforeId 空 = 移到該處尾端
  function surgelocFavMove(id, path, beforeId) {
    var list = surgelocFavAll();
    var idx = -1;
    for (var i = 0; i < list.length; i++) { if (list[i].id === String(id)) { idx = i; break; } }
    if (idx < 0) return list;
    var item = list.splice(idx, 1)[0];
    if (path != null) item.path = surgelocPathNorm(path);
    if (beforeId) {
      var bi = -1;
      for (var j = 0; j < list.length; j++) { if (list[j].id === String(beforeId)) { bi = j; break; } }
      if (bi >= 0) list.splice(bi, 0, item); else list.push(item);
    } else {
      list.push(item);
    }
    surgelocFavWrite(list);
    return list;
  }

  // 用 store 座標套上引擎預設,產生引擎要的 config
  function surgelocConfig() {
    var c = surgelocSaved();
    var cfg = {};
    for (var k in DEFAULT_CONFIG) { if (DEFAULT_CONFIG.hasOwnProperty(k)) cfg[k] = DEFAULT_CONFIG[k]; }
    cfg.latitude = c.lat;
    cfg.longitude = c.lon;
    cfg.mode = "response";
    cfg.debug = false;
    return normalizeConfig(cfg);
  }

  function surgelocMk(a, o) {
    a = parseFloat(a); o = parseFloat(o);
    if (!isNaN(a) && !isNaN(o) && a >= -90 && a <= 90 && o >= -180 && o <= 180) return { lat: a, lon: o };
    return null;
  }

  // 從文字 / Google 地圖網址 / Google 地圖頁面 HTML 解析座標
  function surgelocParse(text) {
    if (!text) return null;
    text = String(text);
    var m, r;
    // 1. Google 頁面 staticmap:center=<lat>,<lon>(%2C 或 ,)—— 對「地址/ftid 型分享」最有效
    m = text.match(/center=(-?\d{1,3}\.\d{3,})(?:%2[Cc]|,)(-?\d{1,3}\.\d{3,})/);
    if (m && (r = surgelocMk(m[1], m[2]))) return r;
    // 2. pb 格式 !2d<經度>!3d<緯度>(! 可能被編碼成 %21;注意順序相反)
    m = text.match(/(?:%21|!)2d(-?\d{1,3}\.\d{3,})(?:%21|!)3d(-?\d{1,3}\.\d{3,})/);
    if (m && (r = surgelocMk(m[2], m[1]))) return r;
    // 3. 一般網址常見樣式
    m = text.match(/@(-?[\d.]+),(-?[\d.]+)/)
     || text.match(/[?&]ll=(-?[\d.]+),(-?[\d.]+)/)
     || text.match(/!3d(-?[\d.]+)!4d(-?[\d.]+)/)
     || text.match(/[?&]q=(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/);
    if (m && (r = surgelocMk(m[1], m[2]))) return r;
    // 4. 純座標對
    m = text.match(/(-?\d{1,3}\.\d{3,})[,\s，]+(-?\d{1,3}\.\d{3,})/);
    if (m && (r = surgelocMk(m[1], m[2]))) return r;
    return null;
  }


  // loc.config 路由:控制台網頁 + API(/cat /fav /reverse /set /clear /search)
  function surgelocHandleConfig() {
    var url = $request.url;
    var path = url.split("?")[0];   // 只用路徑判斷路由,避免查詢字串(如收藏名稱)誤觸其他端點
    function gp(name) { var r = new RegExp("[?&]" + name + "=([^&#]*)", "i"); var x = r.exec(url); return x ? decodeURIComponent(x[1]) : null; }
    function jdone(status, obj) { $done({ response: { status: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) } }); }

    // ---------- 分類 API(/cat/*;放在 /fav 前避免子字串誤判)----------
    if (path.indexOf("/cat/") !== -1) {
      if (path.indexOf("/cat/add") !== -1) {
        var cadd = gp("path");
        jdone(200, { ok: true, cats: surgelocCatAdd(cadd || "") });
        return;
      }
      if (path.indexOf("/cat/rename") !== -1) {
        var cf = gp("from"), ct = gp("to");
        if (cf === null || ct === null) { jdone(400, { ok: false, error: "missing from/to" }); return; }
        surgelocCatRename(cf, ct);
        jdone(200, { ok: true, list: surgelocFavAll(), cats: surgelocCatsAll() });
        return;
      }
      if (path.indexOf("/cat/del") !== -1) {
        var cd = gp("path");
        if (cd === null) { jdone(400, { ok: false, error: "missing path" }); return; }
        surgelocCatDel(cd);
        jdone(200, { ok: true, list: surgelocFavAll(), cats: surgelocCatsAll() });
        return;
      }
      jdone(400, { ok: false, error: "unknown cat endpoint" });
      return;
    }

    // ---------- 收藏 API(需放在 /set 之前:分類/地名可能含 "set"/"clear" 等字)----------
    if (path.indexOf("/fav") !== -1) {
      if (path.indexOf("/fav/list") !== -1) { jdone(200, { ok: true, list: surgelocFavAll(), cats: surgelocCatsAll() }); return; }

      if (path.indexOf("/fav/add") !== -1) {
        var apth = gp("path"), al = gp("lat"), ao = gp("lon"), aq = gp("q"), aplace = gp("place");
        var ac2 = null;
        if (al !== null && ao !== null) ac2 = surgelocMk(al, ao);
        else if (aq) ac2 = surgelocParse(aq);
        else { var cur = surgelocSaved(); ac2 = { lat: cur.lat, lon: cur.lon }; }  // 沒給座標 → 收藏目前位置
        if (!ac2) { jdone(400, { ok: false, error: "invalid coord" }); return; }
        if (!surgelocPathNorm(apth)) apth = "未分類";   // 沒給分類 → 預設「未分類」
        var item = surgelocFavAdd(ac2.lat, ac2.lon, apth, aplace);
        jdone(item ? 200 : 400, item ? { ok: true, item: item } : { ok: false, error: "add failed" });
        return;
      }

      if (path.indexOf("/fav/del") !== -1) {
        var did = gp("id");
        if (!did) { jdone(400, { ok: false, error: "missing id" }); return; }
        jdone(200, { ok: true, list: surgelocFavDel(did) });
        return;
      }

      // 拖曳:移動到某分類 path,並可插到 before 之前(排序)
      if (path.indexOf("/fav/move") !== -1) {
        var mid = gp("id");
        if (!mid) { jdone(400, { ok: false, error: "missing id" }); return; }
        jdone(200, { ok: true, list: surgelocFavMove(mid, gp("path"), gp("before")) });
        return;
      }

      if (path.indexOf("/fav/apply") !== -1) {
        var pid = gp("id");
        var fav = pid ? surgelocFavFind(pid) : null;
        if (!fav) { jdone(404, { ok: false, error: "favorite not found" }); return; }
        surgelocWrite(fav.lat, fav.lon);   // 移動到收藏 → 開啟模擬(off:false)
        surgelocFavMarkMoved(pid);         // 標記近期移動(供上色)
        jdone(200, { ok: true, lat: fav.lat, lon: fav.lon, place: fav.place });
        return;
      }

      jdone(400, { ok: false, error: "unknown fav endpoint" });
      return;
    }

    // 反向地理編碼:座標 → 地名(供收藏自動帶地名)
    if (path.indexOf("/reverse") !== -1) {
      var rlat = gp("lat"), rlon = gp("lon");
      if (rlat === null || rlon === null) { jdone(400, { ok: false, error: "missing lat/lon" }); return; }
      var ru = "https://nominatim.openstreetmap.org/reverse?format=json&zoom=14&accept-language=zh-TW&lat=" +
        encodeURIComponent(rlat) + "&lon=" + encodeURIComponent(rlon);
      $httpClient.get({ url: ru, headers: { "User-Agent": "SurgeLoc/1.0" } }, function (err, resp, data) {
        var place = "";
        try {
          var j = JSON.parse(data || "{}");
          var a = j.address || {};
          // 取「區級 + 市級」等較短好讀的組合,退回 display_name 前兩段
          var parts = [a.suburb || a.city_district || a.town || a.village || a.neighbourhood,
                       a.city || a.county || a.state, a.country].filter(Boolean);
          place = parts.length ? parts.slice(0, 2).join(", ") : String(j.display_name || "").split(",").slice(0, 2).join(",").trim();
        } catch (e) {}
        jdone((err ? 500 : 200), { ok: !err, place: place });
      });
      return;
    }

    if (url.indexOf("/set") !== -1) {
      // 捷徑已自行取得座標,API 只吃 lat/lon(或 q="lat,lon" 座標字串),不再連網解析
      var lat = gp("lat"), lon = gp("lon"), q = gp("q");
      var coord = null;
      if (lat !== null && lon !== null && !isNaN(parseFloat(lat)) && !isNaN(parseFloat(lon))) {
        coord = surgelocMk(lat, lon);
      } else if (q) {
        coord = surgelocParse(q);
      }
      if (coord) {
        surgelocWrite(coord.lat, coord.lon);
        $done({ response: { status: 200, headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ok: true, lat: coord.lat, lon: coord.lon }) } });
      } else {
        $done({ response: { status: 400, headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ok: false, error: "invalid or missing lat/lon" }) } });
      }
      return;
    }

    // 一鍵恢復真實定位:標記 off,引擎停止覆蓋(捷徑可直接打這個)
    if (url.indexOf("/clear") !== -1 || url.indexOf("/restore") !== -1) {
      surgelocSetOff(true);
      $done({ response: { status: 200, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ok: true, off: true }) } });
      return;
    }

    if (url.indexOf("/search") !== -1) {
      var query = gp("q");
      if (query) {
        var su = "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" + encodeURIComponent(query);
        $httpClient.get({ url: su, headers: { "User-Agent": "SurgeLoc/1.0" } }, function (err, resp, data) {
          $done({ response: { status: (err || !resp || resp.status !== 200) ? 500 : 200, headers: { "Content-Type": "application/json" }, body: data || "[]" } });
        });
      } else { $done({ response: { status: 400, body: "[]" } }); }
      return;
    }

    var saved = surgelocSaved();
    $done({ response: { status: 200, headers: { "Content-Type": "text/html" }, body: surgelocHTML(saved) } });
  }

  // 控制台網頁:全螢幕地圖 + 浮動工具列 + 收藏抽屜
  function surgelocHTML(saved) {
    return `<!DOCTYPE html><html><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="SurgeLoc">
<meta name="theme-color" content="#007aff">
<link rel="apple-touch-icon" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAALQAAAC0CAYAAAA9zQYyAAAD+klEQVR42u3b25IUVRCG0bquBwUFPIDMAV9UEARBQUXxgKicJGWYEKOdmOmp7q6qXZkrI77rrvj3uu2ua/z6zyPUTp1bA/bGm1CeABbgEAtukAX2ppD/DmldIAtsmAU1yKoI2wMoDer+8HVIYwWzoIZZpVEbWGlQ94evQpormAU1zEqP2ohKA9qASoO6P3gZUqsBrbqgDaZUqI2lNKD7gxchLSWgVQe0gZQKtXEEtNQi6H7/eUhLDWgBLQEtTQ263/8rpKUHtICWgJaAljYFvfdnSEsP6Ak7OjsAvSiw254ddwDaEPMihnvHqPu9P0LDmvLsPSygG0QMN9DpMUMNdCrIYAOdFjPUZ4G+/iy02pLOe60G9EIhgw10WsxQA50OM9TvQf8e1csFuvZbdjDnO6BhhhpomKEGGmigRwb92dOoVqWr9rYdzFADDTTQQAMN9CSgf4sqzYtq/t+vENAz4wEa6DSYoQa6WdBVvhHoAqArfme7oK/9GtkbFYnvbSqggQYa6PFxAA30pDh8d7Ogf4nsjQPDd7cY0EADDTTQQAMNNNBQQD0U9NWfI3ujoPDdTQY00EADDTTQQAM9Degnkb1xYPjuFgO6URxL/GagFw56LCBL+16ggQYa6BpIYN4W9Kc/RYVG/79ekW9sPaAbQNPytwENNcxA5wJ9Gqi5f78I6B+jUhWv0vsCDTTQQAMNNNQwAw01zENBf/I4KlYCdMF3LQs6O+qqb1oadFbUld+zPOhsqKu/5VvQP0T1coGu/ZZAJ0LtHYFOg9r7AZ0CtvcCGujUoD/+PnSyRWD2TicCGmigoYYZaKCBngb0d6HTaxOzdzktoIEGGmqYgQYaaKCBBnoo6I8ehdbXBGbvsDaggQYaapiBBhroaUA/DJ2/eTDb/bwBDTTQUMMMNNBAA10btZ03AX3l29DwJgFt58EB3Shq+wINtIBuEbVdtwL9TWjzxgFt100DujHU9gQaaAHdImo7Ag20/gf68oPQ9u0EtB23DuhGUNsPaKAFdIuo7bZT0PdDu2sz0HbbVUDPjNpeQAMtoFtEbSeggdYa0Je+Do3TmZjtM0pAAw20tkNtF6CB1vlAH11/6V5ovFYx22Osun/PGEADrcGo7QA00AIa6OqgP7wb0tIDWkBLzYOGWqkwH4P+KqSlBrSAlhYDGmqlwgy08oH+4E5IS6s76wykNJiBVjrQUCsV5mPQt0NqvW7IGUxpMAOtdKChVirMUCsd5negL34ZUit1uzhDKg1mqJUOM9RKh/k/1LdCmqpuijO00mCGWukwQ610mKFWOswrsC/cDGnTuhbPwygNZrCVDjLYSgn5JOwvQuoynoeFOPV5dICBF7Cn3D9vhNe488bfyAAAAABJRU5ErkJggg==">
<title>SurgeLoc</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\/script>
<style>
:root{--acc:#007aff;--txt:#1c1c1e;--sub:#6b6b70;--glass:rgba(255,255,255,.72)}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{font-family:-apple-system,sans-serif;color:var(--txt);overflow:hidden}
#map{position:fixed;inset:0;z-index:1}
.mp{text-align:center;min-width:140px}
.mp-co{font-family:monospace;font-weight:700;font-size:13px;margin-bottom:7px}
.mp-btns{display:flex;gap:6px}
.mp-btns button{flex:1;border:none;border-radius:9px;padding:7px 0;font-size:14px;font-weight:700;cursor:pointer}
.mp-btns .a{background:var(--acc);color:#fff}
.mp-btns .f{background:#ffcc00;color:#3a2d00}
.float{position:fixed;z-index:1000;background:var(--glass);backdrop-filter:blur(20px) saturate(180%);-webkit-backdrop-filter:blur(20px) saturate(180%);box-shadow:0 6px 22px rgba(0,0,0,.16);border:.5px solid rgba(255,255,255,.7)}
.topbar{top:calc(env(safe-area-inset-top,0px) + 10px);left:10px;right:10px;display:flex;gap:8px;align-items:center;padding:5px 5px 5px 14px;border-radius:16px}
.topbar input{flex:1;border:none;background:transparent;font-size:16px;padding:9px 0;outline:none;color:var(--txt)}
.topbar .go{background:var(--acc);color:#fff;border:none;border-radius:12px;padding:9px 16px;font-weight:700;font-size:15px;cursor:pointer;white-space:nowrap}
.topbar .go:disabled{opacity:.5}
.chip{top:calc(env(safe-area-inset-top,0px) + 62px);left:10px;display:flex;align-items:center;gap:7px;padding:6px 12px;border-radius:20px;font-size:12.5px;color:#3c3c43;cursor:pointer;user-select:none}
.chip:active{background:rgba(255,255,255,.9)}
.chip .recen{color:var(--acc);font-size:14px;font-weight:700;margin-left:2px}
.dot{width:9px;height:9px;border-radius:50%;background:#34c759;box-shadow:0 0 0 3px rgba(52,199,89,.2)}
.dot.off{background:#8e8e93;box-shadow:0 0 0 3px rgba(142,142,147,.2)}
.chip .co{font-family:monospace;font-weight:600;color:var(--acc)}
#fab{position:fixed;right:calc(env(safe-area-inset-right,0px) + 14px);bottom:calc(env(safe-area-inset-bottom,0px) + 16px);z-index:1200;display:flex;flex-direction:column;align-items:flex-end;gap:10px}
.fab-menu{display:flex;flex-direction:column;align-items:flex-end;gap:10px;opacity:0;pointer-events:none;transform:translateY(10px) scale(.96);transform-origin:bottom right;transition:opacity .2s,transform .2s}
#fab.open .fab-menu{opacity:1;pointer-events:auto;transform:none}
.fab-item{display:flex;align-items:center;gap:8px;background:var(--glass);backdrop-filter:blur(20px) saturate(180%);-webkit-backdrop-filter:blur(20px) saturate(180%);border:.5px solid rgba(255,255,255,.7);box-shadow:0 4px 16px rgba(0,0,0,.16);color:var(--txt);border-radius:22px;padding:10px 16px;font-size:15px;font-weight:700;cursor:pointer;white-space:nowrap}
.fab-item .fi{font-size:17px;line-height:1}
.fab-item.danger{color:#ff3b30}
.fab-main{width:56px;height:56px;border-radius:50%;background:var(--acc);color:#fff;border:none;font-size:22px;font-weight:400;box-shadow:0 6px 20px rgba(0,122,255,.4);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:transform .2s}
#fab.open .fab-main{transform:rotate(180deg)}
#scrim{position:fixed;inset:0;background:rgba(0,0,0,.28);z-index:1500;opacity:0;pointer-events:none;transition:opacity .25s}
#scrim.show{opacity:1;pointer-events:auto}
#sheet{position:fixed;left:0;right:0;bottom:0;z-index:1600;background:rgba(255,255,255,.94);backdrop-filter:blur(26px) saturate(180%);-webkit-backdrop-filter:blur(26px) saturate(180%);border-radius:22px 22px 0 0;box-shadow:0 -8px 40px rgba(0,0,0,.25);padding:8px 16px calc(env(safe-area-inset-bottom,0px) + 22px);transform:translateY(105%);transition:transform .32s cubic-bezier(.32,.72,0,1);max-height:80vh;overflow-y:auto;-webkit-overflow-scrolling:touch}
#sheet.show{transform:translateY(0)}
.grab{width:38px;height:5px;border-radius:3px;background:#c7c7cc;margin:6px auto 10px}
.sheet-hd{display:flex;align-items:center;justify-content:space-between;font-size:17px;font-weight:700;margin-bottom:10px}
.hd-r{display:flex;align-items:center;gap:8px}
.edit{background:rgba(0,122,255,.12);color:var(--acc);border:none;border-radius:20px;padding:5px 14px;font-size:13px;font-weight:700;cursor:pointer}
.sheet-hd .x{background:rgba(120,120,128,.14);color:#8e8e93;border:none;width:26px;height:26px;border-radius:50%;font-size:13px;cursor:pointer;line-height:1}
.addfav{width:100%;background:var(--acc);color:#fff;border:none;border-radius:12px;padding:12px;font-weight:700;font-size:15px;cursor:pointer;margin-bottom:2px}
.addfav:disabled{opacity:.5}
.addcat{width:100%;background:rgba(0,122,255,.1);color:var(--acc);border:1px dashed var(--acc);border-radius:11px;padding:10px;font-weight:700;font-size:14px;cursor:pointer;margin:8px 0 2px}
.cat{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:700;margin:8px 0 1px;user-select:none}
.cat .tw{color:var(--sub);font-size:10px;cursor:pointer;width:12px;text-align:center}
.cat .cname{cursor:pointer;color:var(--acc)}
.cat-edit{display:flex;gap:4px;margin-left:auto}
.cbtn{border:none;background:#8e8e93;color:#fff;padding:3px 8px;font-size:11px;font-weight:600;border-radius:7px;cursor:pointer}
.cbtn.red{background:#ff3b30}
.cat.drop-into{background:rgba(0,122,255,.14);border-radius:8px}
.fav-item{display:flex;align-items:center;gap:9px;padding:9px 2px;border-top:1px solid #e5e5ea}
.fav-item.dragging{opacity:.35}
.fav-item.drop-before{border-top:2px solid var(--acc)}
.dragh{color:#c7c7cc;font-size:18px;cursor:grab;touch-action:none;padding:0 2px;flex-shrink:0}
.fav-info{flex:1;min-width:0;cursor:pointer}
.fav-place{font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fav-co{font-family:monospace;font-size:10.5px;color:var(--sub);margin-top:1px}
.fav-right{flex-shrink:0;display:flex;flex-direction:column;align-items:flex-end}
.fav-time .t{font-size:16px;font-weight:400;font-variant-numeric:tabular-nums;line-height:1}
.fav-time .z{font-size:9px;color:var(--sub);margin-left:2px}
.mini{border:none;padding:4px 9px;font-size:11px;font-weight:600;border-radius:8px;cursor:pointer;color:#fff}
.mini.red{background:#ff3b30}
.ghost{position:fixed;z-index:3000;background:rgba(0,122,255,.92);color:#fff;font-size:13px;font-weight:700;padding:6px 12px;border-radius:10px;pointer-events:none;box-shadow:0 8px 24px rgba(0,0,0,.3);transform:translateY(-50%);max-width:60vw;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.mvtag{font-size:9px;font-weight:700;padding:1px 6px;border-radius:6px;margin-left:6px;vertical-align:middle}
.fav-item.mv1h .fav-place{color:#34c759}
.fav-item.mv1h .mvtag{background:rgba(52,199,89,.16);color:#1a7a3a}
.fav-item.mvday .fav-place{color:#ff9500}
.fav-item.mvday .mvtag{background:rgba(255,149,0,.16);color:#a85e00}
.fav-empty{font-size:13px;color:var(--sub);text-align:center;padding:18px 0}
.tip{font-size:11px;color:#8e8e93;text-align:center;margin-top:14px}
#toast{position:fixed;left:50%;bottom:calc(env(safe-area-inset-bottom,0px) + 92px);transform:translateX(-50%) translateY(20px);z-index:2000;width:min(92vw,430px);display:flex;flex-direction:column;gap:10px;padding:13px 15px;border-radius:14px;background:rgba(28,28,30,.94);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);color:#fff;font-size:13.5px;font-weight:600;box-shadow:0 8px 30px rgba(0,0,0,.35);opacity:0;pointer-events:none;transition:opacity .25s,transform .25s}
#toast.show{opacity:1;transform:translateX(-50%) translateY(0);pointer-events:auto}
#toast .tmsg{line-height:1.4;text-align:center}
#toast .tbtns{display:flex;gap:8px}
#toast .tbtns button{flex:1;border:none;border-radius:9px;padding:9px 0;font-size:14px;font-weight:700;cursor:pointer}
#toast .tact{background:var(--acc);color:#fff}
#toast .tclose{background:rgba(255,255,255,.16);color:#fff}
#modal{position:fixed;inset:0;z-index:2500;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;padding:24px;opacity:0;pointer-events:none;transition:opacity .2s}
#modal.show{opacity:1;pointer-events:auto}
.mbox{width:100%;max-width:320px;background:rgba(250,250,252,.98);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border-radius:16px;padding:18px;box-shadow:0 20px 60px rgba(0,0,0,.3);transform:scale(.95);transition:transform .2s}
#modal.show .mbox{transform:scale(1)}
.mtitle{font-size:15px;font-weight:700;text-align:center;margin-bottom:14px;line-height:1.4;color:#1c1c1e}
.minput{width:100%;border:1px solid #d1d1d6;border-radius:10px;padding:11px;font-size:16px;outline:none;margin-bottom:14px;background:#fff;color:#1c1c1e}
.mbtns{display:flex;gap:8px}
.mbtns button{flex:1;border:none;border-radius:10px;padding:11px 0;font-size:15px;font-weight:700;cursor:pointer}
.mcancel{background:rgba(120,120,128,.16);color:#3c3c43}
.mok{background:var(--acc);color:#fff}
</style></head><body>
<div id="map"></div>

<div class="float topbar">
<input type="text" id="i" placeholder="搜尋地址或座標…" onkeydown="if(event.key==='Enter')resolve()">
<button class="go" id="btn" onclick="resolve()">前往</button>
</div>

<div class="float chip" onclick="recenter()"><span class="dot" id="dot"></span><span id="stTxt">模擬中</span> · <span class="co" id="ll">${saved.lat.toFixed(5)}, ${saved.lon.toFixed(5)}</span><span class="recen">◎</span></div>

<div id="fab">
<div class="fab-menu">
<button class="fab-item danger" onclick="fabClose();restore()"><span class="fi">↩︎</span>復原</button>
<button class="fab-item" onclick="fabClose();openSheet()"><span class="fi">⭐</span>收藏</button>
</div>
<button class="fab-main" onclick="fabToggle()">☰</button>
</div>

<div id="toast"><div class="tmsg"></div><div class="tbtns" style="display:none"><button class="tact"></button><button class="tclose" onclick="hideToast()">關閉</button></div></div>

<div id="modal"><div class="mbox"><div class="mtitle"></div><input class="minput" type="text" onkeydown="if(event.key==='Enter')modalOk()"><div class="mbtns"><button class="mcancel" onclick="modalCancel()">取消</button><button class="mok" onclick="modalOk()">確定</button></div></div></div>

<div id="scrim" onclick="closeSheet()"></div>
<div id="sheet">
<div class="grab"></div>
<div class="sheet-hd">收藏<div class="hd-r"><button id="editBtn" class="edit" onclick="toggleEdit()">編輯</button><button class="x" onclick="closeSheet()">✕</button></div></div>
<div id="editTools" style="display:none"><button class="addcat" onclick="addRootCat()">＋ 新增分類</button></div>
<div id="favList"></div>
<div class="tip">移動或復原後,皆須重啟系統「定位服務」開關</div>
</div>

<script>
var cLat=${saved.lat},cLon=${saved.lon},cOff=${saved.off};
/* 目前「模擬中(已套用)」的座標;chip 顯示它,點 chip 飛回這裡 */
var simLat=${saved.lat},simLon=${saved.lon};
function setSim(a,o){simLat=a;simLon=o;var e=document.getElementById('ll');if(e)e.textContent=a.toFixed(5)+', '+o.toFixed(5);}
function recenter(){pendingFavId=null;map.flyTo([simLat,simLon],16);up(simLat,simLon);}
function setState(off){cOff=off;var d=document.getElementById('dot'),t=document.getElementById('stTxt');if(off){d.className='dot off';t.textContent='已恢復真實';}else{d.className='dot';t.textContent='模擬中';}}
var map=L.map('map',{zoomControl:false}).setView([cLat,cLon],15);
L.control.zoom({position:'bottomleft'}).addTo(map);
L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',{subdomains:'abcd',maxZoom:20,attribution:'© OpenStreetMap © CARTO'}).addTo(map);
var mk=L.marker([cLat,cLon],{draggable:true}).addTo(map);
mk.bindPopup(mpop(cLat,cLon)).openPopup();
map.on('click',function(e){fabClose();var t=e.originalEvent&&e.originalEvent.target;if(t&&t.closest&&t.closest('.leaflet-popup'))return;pendingFavId=null;up(e.latlng.lat,e.latlng.lng);});
mk.on('drag',function(){var p=mk.getLatLng();mk.getPopup().setContent(mpop(p.lat,p.lng))});
mk.on('dragend',function(){pendingFavId=null;var p=mk.getLatLng();up(p.lat,p.lng)});
setState(cOff);
setTimeout(function(){map.invalidateSize()},200);
/* 選定但尚未套用的收藏(供「移動」時記錄近期移動)*/
var pendingFavId=null;
/* 網頁內通知條(取代 alert / Surge 通知)*/
var toastTimer=null;
function toast(msg,actLabel,actFn,closeLabel){
  var t=document.getElementById('toast');t.querySelector('.tmsg').textContent=msg;
  var btns=t.querySelector('.tbtns'),b=t.querySelector('.tact'),cb=t.querySelector('.tclose');
  clearTimeout(toastTimer);
  if(actLabel){
    btns.style.display='flex';b.textContent=actLabel;b.onclick=function(){hideToast();actFn&&actFn();};
    cb.textContent=closeLabel||'關閉';
    // 有動作 → 不自動關閉,由使用者按下按鈕
  }else{
    btns.style.display='none';toastTimer=setTimeout(hideToast,2400);
  }
  t.classList.add('show');
}
function hideToast(){document.getElementById('toast').classList.remove('show');}
function openLoc(){location.href='prefs:root=Privacy&path=LOCATION';}
/* 右下浮動選單 */
function fabToggle(){var f=document.getElementById('fab');f.classList.toggle('open');f.querySelector('.fab-main').textContent=f.classList.contains('open')?'✕':'☰';}
function fabClose(){var f=document.getElementById('fab');f.classList.remove('open');f.querySelector('.fab-main').textContent='☰';}
/* 自製彈窗(iOS 主畫面獨立 App 會封鎖原生 prompt/confirm/alert)*/
var modalCb=null;
function showModal(title,withInput,defVal,cb,placeholder){
  var m=document.getElementById('modal');m.querySelector('.mtitle').textContent=title;
  var inp=m.querySelector('.minput');
  if(withInput){inp.style.display='';inp.value=defVal||'';inp.placeholder=placeholder||'';}else{inp.style.display='none';}
  modalCb=cb;m.classList.add('show');
  if(withInput)setTimeout(function(){inp.focus();},60);
}
function modalOk(){var m=document.getElementById('modal');var inp=m.querySelector('.minput');var v=(inp.style.display==='none')?true:inp.value;m.classList.remove('show');var cb=modalCb;modalCb=null;if(cb)cb(v);}
function modalCancel(){document.getElementById('modal').classList.remove('show');var cb=modalCb;modalCb=null;if(cb)cb(null);}
function dlgInput(title,defVal,cb,placeholder){showModal(title,true,defVal,cb,placeholder);}
function dlgConfirm(title,cb){showModal(title,false,'',function(v){cb(v!==null);});}
/* 地圖氣泡:座標 + 移動 / 收藏(移動才會真的改定位)*/
function mpop(a,o){return '<div class="mp"><div class="mp-co">'+a.toFixed(5)+', '+o.toFixed(5)+'</div><div class="mp-btns"><button class="a" onclick="event.stopPropagation();doMove()">移動</button><button class="f" onclick="event.stopPropagation();addFav()">收藏</button></div></div>';}
function up(a,o){while(o>180)o-=360;while(o<-180)o+=360;cLat=a;cLon=o;mk.setLatLng([a,o]);mk.getPopup().setContent(mpop(a,o));mk.openPopup();}
async function resolve(){
  var b=document.getElementById('btn'),v=document.getElementById('i').value.trim();if(!v)return;
  var p=v.split(/[\\s,，]+/);
  if(p.length>=2&&!isNaN(p[0])&&!isNaN(p[1])){var a=parseFloat(p[0]),o=parseFloat(p[1]);pendingFavId=null;map.flyTo([a,o],16);up(a,o);toast('已定位到地圖,按「移動」套用');return;}
  b.disabled=true;b.innerText='…';
  try{var r=await fetch('/search?q='+encodeURIComponent(v)+'&t='+Date.now());var d=await r.json();
    if(d&&d.length>0){var a=parseFloat(d[0].lat),o=parseFloat(d[0].lon);pendingFavId=null;map.flyTo([a,o],16);up(a,o);toast('已定位到地圖,按「移動」套用');}
    else{toast('找不到地點')}}
  catch(e){toast('搜尋失敗')}
  finally{b.disabled=false;b.innerText='前往'}
}
/* 移動:真正改定位。若來自收藏(pendingFavId)走 /fav/apply(會記近期移動),否則走 /set */
async function doMove(){
  try{
    if(pendingFavId){await fetch('/fav/apply?id='+pendingFavId+'&t='+Date.now());}
    else{await fetch('/set?lat='+cLat+'&lon='+cLon+'&t='+Date.now());}
    setState(false);pendingFavId=null;setSim(cLat,cLon);
    toast('已移動到新位置,請重啟定位服務開關','前往',openLoc);
  }catch(e){toast('移動失敗');}
}
function restore(){toast('確定要復原真實定位?','確定',doRestore,'取消');}
async function doRestore(){try{await fetch('/clear?t='+Date.now());setState(true);toast('已復原真實定位,請重啟定位服務開關','前往',openLoc);}catch(e){toast('復原失敗');}}

/* ---------- 收藏抽屜(多層分類 + 編輯 + 拖曳)---------- */
function openSheet(){document.getElementById('sheet').classList.add('show');document.getElementById('scrim').classList.add('show');loadFavs();}
function closeSheet(){document.getElementById('sheet').classList.remove('show');document.getElementById('scrim').classList.remove('show');}
var FAVS=[],CATS=[],EDIT=false,lastPath='';
var COLL={};try{COLL=JSON.parse(localStorage.getItem('favColl')||'{}');}catch(e){COLL={};}
function saveColl(){localStorage.setItem('favColl',JSON.stringify(COLL));}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
function tzOff(lon){return Math.round(Number(lon)/15);}
function localHM(lon){var off=tzOff(lon),n=new Date();var d=new Date(n.getTime()+n.getTimezoneOffset()*60000+off*3600000);function p(x){return(x<10?'0':'')+x;}return p(d.getHours())+':'+p(d.getMinutes());}
function tzLabel(lon){var off=tzOff(lon);return 'UTC'+(off>=0?'+':'')+off;}
function tickClocks(){var els=document.querySelectorAll('.fav-time');for(var i=0;i<els.length;i++){var lon=els[i].getAttribute('data-lon');els[i].querySelector('.t').textContent=localHM(lon);}}
function toggleEdit(){EDIT=!EDIT;document.getElementById('editBtn').textContent=EDIT?'完成':'編輯';document.getElementById('editTools').style.display=EDIT?'block':'none';render();}
async function loadFavs(){try{var r=await fetch('/fav/list?t='+Date.now());var d=await r.json();FAVS=(d&&d.list)||[];CATS=(d&&d.cats)||[];render();}catch(e){}}
function buildTree(cats,favs){
  var root={name:'',path:'',kids:{},order:[],favs:[]};
  function node(p){if(!p)return root;var segs=p.split('/'),cur=root,acc='';for(var i=0;i<segs.length;i++){acc=acc?acc+'/'+segs[i]:segs[i];if(!cur.kids[segs[i]]){cur.kids[segs[i]]={name:segs[i],path:acc,kids:{},order:[],favs:[]};cur.order.push(segs[i]);}cur=cur.kids[segs[i]];}return cur;}
  (cats||[]).forEach(function(p){node(p);});
  (favs||[]).forEach(function(f){node(f.path).favs.push(f);});
  return root;
}
/* 近期移動上色:1 小時內=mv1h(綠),當天=mvday(橘)*/
function movedClass(ts){if(!ts)return '';var now=Date.now();if(now-ts<3600000)return 'mv1h';var d=new Date(ts),n=new Date();if(d.getFullYear()===n.getFullYear()&&d.getMonth()===n.getMonth()&&d.getDate()===n.getDate())return 'mvday';return '';}
function favRow(x,depth){
  var pad=depth*16,place=x.place?esc(x.place):'(未命名地點)';
  var mc=movedClass(x.movedAt),badge=mc==='mv1h'?'<span class="mvtag">剛移動</span>':(mc==='mvday'?'<span class="mvtag">今天</span>':'');
  var h='<div class="fav-item'+(mc?' '+mc:'')+'" data-id="'+esc(x.id)+'" data-path="'+esc(x.path)+'" style="padding-left:'+pad+'px">';
  if(EDIT)h+='<span class="dragh">≡</span>';
  h+='<div class="fav-info" data-act="'+(EDIT?'noop':'apply')+'" data-id="'+esc(x.id)+'"><div class="fav-place">'+place+badge+'</div><div class="fav-co">'+x.lat.toFixed(5)+', '+x.lon.toFixed(5)+'</div></div>';
  if(EDIT)h+='<button class="mini red" data-act="del" data-id="'+esc(x.id)+'">✕ 移除</button>';
  else h+='<div class="fav-right"><div class="fav-time" data-lon="'+x.lon+'"><span class="t">'+localHM(x.lon)+'</span><span class="z">'+tzLabel(x.lon)+'</span></div></div>';
  return h+'</div>';
}
function renderCat(c,depth,out){
  var coll=COLL[c.path],pad=depth*16;
  out.push('<div class="cat" data-path="'+esc(c.path)+'" style="padding-left:'+pad+'px">'
    +'<span class="tw" data-act="toggle" data-path="'+esc(c.path)+'">'+(coll?'▸':'▾')+'</span>'
    +'<span class="cname" data-act="toggle" data-path="'+esc(c.path)+'">'+esc(c.name)+'</span>'
    +(EDIT?'<span class="cat-edit"><button class="cbtn" data-act="addsub" data-path="'+esc(c.path)+'">＋子</button><button class="cbtn" data-act="renamecat" data-path="'+esc(c.path)+'">改名</button><button class="cbtn red" data-act="delcat" data-path="'+esc(c.path)+'">刪</button></span>':'')
    +'</div>');
  if(!coll){c.favs.forEach(function(f){out.push(favRow(f,depth+1));});c.order.forEach(function(k){renderCat(c.kids[k],depth+1,out);});}
}
function render(){
  var box=document.getElementById('favList');
  if(!FAVS.length&&!CATS.length){box.innerHTML='<div class="fav-empty">尚無收藏,在地圖上點一下 → 按「收藏」新增</div>';return;}
  var root=buildTree(CATS,FAVS),out=[];
  root.favs.forEach(function(f){out.push(favRow(f,0));});
  root.order.forEach(function(k){renderCat(root.kids[k],0,out);});
  box.innerHTML=out.join('')||'<div class="fav-empty">尚無收藏</div>';
}
function addFav(){
  dlgInput('要收藏到哪個分類?',lastPath,function(c){
    if(c===null)return;c=String(c).trim();lastPath=c;
    (async function(){
      var place='';
      try{var rr=await fetch('/reverse?lat='+cLat+'&lon='+cLon+'&t='+Date.now());var rd=await rr.json();if(rd&&rd.place)place=rd.place;}catch(e){}
      try{await fetch('/fav/add?path='+encodeURIComponent(c)+'&lat='+cLat+'&lon='+cLon+'&place='+encodeURIComponent(place)+'&t='+Date.now());}catch(e){}
      loadFavs();toast('已收藏');
    })();
  },'未分類');
}
/* 點收藏:只移動地圖到該點並開氣泡,不直接改定位;按「移動」才套用 */
function selectFav(id){
  var f=null;for(var i=0;i<FAVS.length;i++){if(FAVS[i].id===id){f=FAVS[i];break;}}
  if(!f)return;
  pendingFavId=id;map.flyTo([f.lat,f.lon],16);up(f.lat,f.lon);closeSheet();
  toast('已移到地圖,按「移動」套用');
}
function delFav(id){dlgConfirm('移除這個收藏?',function(ok){if(!ok)return;fetch('/fav/del?id='+id+'&t='+Date.now()).then(function(){loadFavs();toast('已移除');});});}
function addRootCat(){dlgInput('新增分類名稱:','',function(n){if(n===null)return;n=String(n).trim();if(!n)return;fetch('/cat/add?path='+encodeURIComponent(n)+'&t='+Date.now()).then(function(){loadFavs();});});}
function addSubCat(p){dlgInput('在「'+p+'」底下新增子分類:','',function(n){if(n===null)return;n=String(n).trim();if(!n)return;fetch('/cat/add?path='+encodeURIComponent(p+'/'+n)+'&t='+Date.now()).then(function(){loadFavs();});});}
function renameCat(p){var segs=p.split('/'),cur=segs[segs.length-1];dlgInput('分類改名:',cur,function(to){if(to===null)return;to=String(to).trim();if(!to||to===cur)return;segs[segs.length-1]=to;fetch('/cat/rename?from='+encodeURIComponent(p)+'&to='+encodeURIComponent(segs.join('/'))+'&t='+Date.now()).then(function(){loadFavs();});});}
function delCat(p){dlgConfirm('刪除分類「'+p+'」及其中所有收藏?',function(ok){if(!ok)return;fetch('/cat/del?path='+encodeURIComponent(p)+'&t='+Date.now()).then(function(){loadFavs();});});}
/* 事件委派:點擊 */
var favListEl=document.getElementById('favList');
favListEl.addEventListener('click',function(e){
  var el=e.target.closest&&e.target.closest('[data-act]');if(!el)return;
  var act=el.getAttribute('data-act'),id=el.getAttribute('data-id'),p=el.getAttribute('data-path');
  if(act==='apply')selectFav(id);
  else if(act==='del')delFav(id);
  else if(act==='toggle'){COLL[p]=!COLL[p];saveColl();render();}
  else if(act==='addsub')addSubCat(p);
  else if(act==='renamecat')renameCat(p);
  else if(act==='delcat')delCat(p);
});
/* 拖曳排序 / 換分類(編輯模式)*/
var dragId=null,ghost=null,curDrop=null;
favListEl.addEventListener('pointerdown',function(e){
  if(!EDIT)return;var h=e.target.closest&&e.target.closest('.dragh');if(!h)return;
  var row=h.closest('.fav-item');if(!row)return;
  e.preventDefault();dragId=row.getAttribute('data-id');row.classList.add('dragging');
  ghost=document.createElement('div');ghost.className='ghost';ghost.textContent=row.querySelector('.fav-place').textContent;
  document.body.appendChild(ghost);moveGhost(e);
  document.addEventListener('pointermove',onDrag);document.addEventListener('pointerup',onDrop);
});
function moveGhost(e){if(ghost){ghost.style.left=(e.clientX+12)+'px';ghost.style.top=e.clientY+'px';}}
function clearHints(){var a=favListEl.querySelectorAll('.drop-before,.drop-into');for(var i=0;i<a.length;i++)a[i].classList.remove('drop-before','drop-into');}
function onDrag(e){
  e.preventDefault();moveGhost(e);clearHints();curDrop=null;
  var t=document.elementFromPoint(e.clientX,e.clientY);if(!t||!t.closest)return;
  var item=t.closest('.fav-item'),cat=t.closest('.cat');
  if(item&&item.getAttribute('data-id')!==dragId){item.classList.add('drop-before');curDrop={path:item.getAttribute('data-path'),before:item.getAttribute('data-id')};}
  else if(cat){cat.classList.add('drop-into');curDrop={path:cat.getAttribute('data-path'),before:null};}
}
async function onDrop(){
  document.removeEventListener('pointermove',onDrag);document.removeEventListener('pointerup',onDrop);
  if(ghost){ghost.remove();ghost=null;}clearHints();
  var did=dragId,dr=curDrop;dragId=null;curDrop=null;
  var drow=favListEl.querySelector('.fav-item.dragging');if(drow)drow.classList.remove('dragging');
  if(did&&dr){var qs='/fav/move?id='+did+'&path='+encodeURIComponent(dr.path||'');if(dr.before)qs+='&before='+dr.before;await fetch(qs+'&t='+Date.now());await loadFavs();}
}
loadFavs();setInterval(tickClocks,15000);
<\/script></body></html>`;
  }

  // 路由:loc.config → 控制台/API;wloc 回應 → 用 store 座標覆蓋
  function runSurgeLoc() {
    var hasReq = typeof $request !== "undefined" && $request != null;
    var hasResp = typeof $response !== "undefined" && $response != null;
    if (hasReq && $request.url && $request.url.indexOf(SURGELOC_CONFIG_HOST) !== -1) {
      surgelocHandleConfig();
      return;
    }
    if (hasResp) {
      // 已按「恢復真實定位」→ 原樣放行,讓 iOS 拿回真實位置
      if (surgelocSaved().off) { donePassThrough(); return; }
      try { continueResponseRewrite(surgelocConfig()); }
      catch (e) { donePassThrough(); }
      return;
    }
    donePassThrough();
  }


  var api = {
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    APPLE_WLOC_PREFIX: APPLE_WLOC_PREFIX,
    APPLE_WLOC_MARKER: APPLE_WLOC_MARKER,
    bodyToBytes: bodyToBytes,
    messageBodyToBytes: messageBodyToBytes,
    hexPreview: hexPreview,
    bytesToBinaryString: bytesToBinaryString,
    bytesToBase64: bytesToBase64,
    binaryStringToBytes: binaryStringToBytes,
    concatBytes: concatBytes,
    readUInt16BE: readUInt16BE,
    writeUInt16BE: writeUInt16BE,
    encodeVarintUnsigned: encodeVarintUnsigned,
    encodeVarintSignedInt64: encodeVarintSignedInt64,
    decodeVarint: decodeVarint,
    makeVarintField: makeVarintField,
    makeLengthDelimitedField: makeLengthDelimitedField,
    parseFields: parseFields,
    tryParseFields: tryParseFields,
    firstFieldByNumber: firstFieldByNumber,
    locationSummary: locationSummary,
    patchedPayloadSummary: patchedPayloadSummary,
    coordToInt: coordToInt,
    normalizeConfig: normalizeConfig,
    patchLocation: patchLocation,
    patchWifiDevice: patchWifiDevice,
    patchCellTower: patchCellTower,
    patchAppleWLocPayload: patchAppleWLocPayload,
    parseArpc: parseArpc,
    serializeArpc: serializeArpc,
    buildAppleWLocResponse: buildAppleWLocResponse,
    extractAppleWLocPayload: extractAppleWLocPayload,
    spoofArpcRequest: spoofArpcRequest,
    spoofAppleResponse: spoofAppleResponse,
    parseArgumentString: parseArgumentString,
    readScriptArguments: readScriptArguments,
    geocodeAddress: geocodeAddress,
    prepareRequestHeaders: prepareRequestHeaders
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    runSurgeLoc();
  }
}());
