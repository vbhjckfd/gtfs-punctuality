// Minimal GTFS-RT VehiclePosition decoder. Reads only the fields departure
// detection needs, and returns whatever it managed to parse if the buffer is
// truncated (the collector archive contains a few cut-off snapshots).

function varint(b, o) {
  let lo = 0, shift = 0, byte;
  do {
    byte = b[o.p++];
    if (byte === undefined) throw new RangeError("eof");
    lo += (byte & 0x7f) * 2 ** shift; // plain arithmetic: timestamps exceed 32 bits
    shift += 7;
  } while (byte & 0x80);
  return lo;
}

function skip(b, o, wire) {
  if (wire === 0) varint(b, o);
  else if (wire === 1) o.p += 8;
  else if (wire === 2) { const len = varint(b, o); o.p += len; }
  else if (wire === 5) o.p += 4;
  else throw new RangeError("wire type " + wire);
}

const dec = new TextDecoder();

function eachField(b, start, end, fn) {
  const o = { p: start };
  while (o.p < end) {
    const tag = varint(b, o);
    const f = tag >>> 3, w = tag & 7;
    if (!fn(f, w, o)) skip(b, o, w);
  }
}

function str(b, o) {
  const len = varint(b, o);
  const s = dec.decode(b.subarray(o.p, o.p + len));
  o.p += len;
  return s;
}

function sub(b, o, fn) {
  const len = varint(b, o);
  const end = o.p + len;
  fn(end);
  o.p = end;
}

const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/** @returns {{timestamp:number, vehicles:Array<{vehicleId,tripId,routeId,lat,lon,speed,timestamp}>}} */
export function decodeFeed(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = view(b);
  const out = { timestamp: 0, vehicles: [] };
  try {
    eachField(b, 0, b.length, (f, w, o) => {
      if (f === 1 && w === 2) { // header
        sub(b, o, (end) => eachField(b, o.p, end, (hf, hw, ho) => {
          if (hf === 3 && hw === 0) { out.timestamp = varint(b, ho); return true; }
          return false;
        }));
        return true;
      }
      if (f === 2 && w === 2) { // entity
        sub(b, o, (end) => {
          let v = null;
          eachField(b, o.p, end, (ef, ew, eo) => {
            if (ef === 4 && ew === 2) { // vehicle
              v = { vehicleId: "", tripId: "", routeId: "", lat: NaN, lon: NaN, speed: 0, timestamp: 0 };
              sub(b, eo, (vend) => eachField(b, eo.p, vend, (vf, vw, vo) => {
                if (vf === 1 && vw === 2) { // trip
                  sub(b, vo, (tend) => eachField(b, vo.p, tend, (tf, tw, to) => {
                    if (tf === 1 && tw === 2) { v.tripId = str(b, to); return true; }
                    if (tf === 5 && tw === 2) { v.routeId = str(b, to); return true; }
                    return false;
                  }));
                  return true;
                }
                if (vf === 2 && vw === 2) { // position
                  sub(b, vo, (pend) => eachField(b, vo.p, pend, (pf, pw, po) => {
                    if (pf === 1 && pw === 5) { v.lat = dv.getFloat32(po.p, true); po.p += 4; return true; }
                    if (pf === 2 && pw === 5) { v.lon = dv.getFloat32(po.p, true); po.p += 4; return true; }
                    if (pf === 5 && pw === 5) { v.speed = dv.getFloat32(po.p, true); po.p += 4; return true; }
                    return false;
                  }));
                  return true;
                }
                if (vf === 5 && vw === 0) { v.timestamp = varint(b, vo); return true; }
                if (vf === 8 && vw === 2) { // vehicle descriptor
                  sub(b, vo, (dend) => eachField(b, vo.p, dend, (df, dw, dO) => {
                    if (df === 1 && dw === 2) { v.vehicleId = str(b, dO); return true; }
                    return false;
                  }));
                  return true;
                }
                return false;
              }));
              return true;
            }
            return false;
          });
          if (v && v.tripId && v.vehicleId) out.vehicles.push(v);
        });
        return true;
      }
      return false;
    });
  } catch {
    // truncated buffer: keep what was parsed
  }
  return out;
}
