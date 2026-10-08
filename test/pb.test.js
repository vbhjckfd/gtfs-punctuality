import { describe, it, expect } from "vitest";
import { decodeFeed } from "../src/pb.js";

// tiny protobuf encoder, just enough for the fields the decoder reads
const varint = (n) => { const o = []; while (n >= 128) { o.push((n % 128) | 128); n = Math.floor(n / 128); } o.push(n); return o; };
const tag = (f, w) => varint((f << 3) | w);
const ld = (f, bytes) => [...tag(f, 2), ...varint(bytes.length), ...bytes];
const s = (f, str) => ld(f, [...new TextEncoder().encode(str)]);
const f32 = (f, x) => [...tag(f, 5), ...new Uint8Array(new Float32Array([x]).buffer)];

const entity = (trip, vehicle, lat, lon, ts) => ld(2, [
  ...s(1, "e1"),
  ...ld(4, [
    ...ld(1, [...s(1, trip), ...s(5, "104")]),
    ...ld(2, [...f32(1, lat), ...f32(2, lon), ...f32(5, 3.5)]),
    ...tag(5, 0), ...varint(ts),
    ...ld(8, s(1, vehicle)),
  ]),
]);
const header = (ts) => ld(1, [...s(1, "2.0"), ...tag(3, 0), ...varint(ts)]);

describe("decodeFeed", () => {
  it("reads header timestamp and vehicle fields", () => {
    const buf = new Uint8Array([...header(1791488102), ...entity("32612_5_0", "1944", 49.838, 24.0064, 1791488073)]);
    const f = decodeFeed(buf);
    expect(f.timestamp).toBe(1791488102);
    expect(f.vehicles).toHaveLength(1);
    const v = f.vehicles[0];
    expect(v).toMatchObject({ tripId: "32612_5_0", routeId: "104", vehicleId: "1944", timestamp: 1791488073 });
    expect(v.lat).toBeCloseTo(49.838, 3);
    expect(v.lon).toBeCloseTo(24.0064, 3);
    expect(v.speed).toBeCloseTo(3.5, 3);
  });

  it("keeps entities decoded before a truncation", () => {
    const full = new Uint8Array([...header(10), ...entity("a", "1", 1, 1, 5), ...entity("b", "2", 1, 1, 6)]);
    const f = decodeFeed(full.subarray(0, full.length - 6));
    expect(f.timestamp).toBe(10);
    expect(f.vehicles.map((v) => v.tripId)).toEqual(["a"]);
  });

  it("returns an empty feed for garbage", () => {
    expect(decodeFeed(new Uint8Array([0xff, 0xff, 0xff])).vehicles).toEqual([]);
  });
});
