import { describe, test, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { decodePcode, PcodeDecodeError } from "./pcode-decoder";
import { parseGcode } from "./parser";
import { FEATURE_OUTER_WALL, FEATURE_SEAM_START, FEATURE_TOP_SURFACE } from "./features";

const FIXTURES = path.resolve(__dirname, "../fixtures");

/**
 * Reads `fixtures/pcode/<name>.pcode` and slices it down to the file's exact
 * bytes. `Buffer`s returned by `readFileSync` are frequently backed by a
 * larger, shared pooled `ArrayBuffer` — handing that raw `.buffer` to
 * `decodePcode` without slicing would let bytes from unrelated reads leak into
 * the "buffer" the decoder sees, and would silently pass even if `decodePcode`
 * ignored `byteOffset`/`byteLength` entirely.
 */
function loadFixture(name: string): ArrayBuffer {
  const b = readFileSync(path.join(FIXTURES, "pcode", `${name}.pcode`));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

describe("decodePcode", () => {
  test("returns the ParsedGcodeArrays shape the renderer consumes", () => {
    const model = decodePcode(loadFixture("prusaslicer"));
    expect(model.xs).toBeInstanceOf(Float32Array);
    expect(Array.isArray(model.layers)).toBe(true);
    expect(model.count).toBeGreaterThan(0);
    expect(model.xs.length).toBe(model.count);
    expect(model.ys.length).toBe(model.count);
    expect(model.zs.length).toBe(model.count);
    expect(model.isTravel.length).toBe(model.count);
    expect(model.featureType.length).toBe(model.count);
    expect(model.width.length).toBe(model.count);
  });

  test("layers and bounds agree with the source gcode", () => {
    const source = readFileSync(path.join(FIXTURES, "gcode", "prusaslicer.gcode"), "utf8");
    const expected = parseGcode(source);
    const model = decodePcode(loadFixture("prusaslicer"));

    expect(model.layers).toEqual(expected.layers);
    expect(model.bounds.minX).toBeCloseTo(expected.bounds.minX, 2);
    expect(model.bounds.maxX).toBeCloseTo(expected.bounds.maxX, 2);
    expect(model.bounds.maxZ).toBeCloseTo(expected.bounds.maxZ, 3);
  });

  // The artifact is decimated relative to its source gcode, so point counts
  // legitimately differ — only the carried-verbatim fields (`layers`) and
  // the bounds (to float tolerance) are expected to match exactly.
  test("decoding a fixture agrees with parsing its source gcode", () => {
    const gcode = readFileSync(path.join(FIXTURES, "gcode", "prusaslicer.gcode"), "utf8");
    const parsed = parseGcode(gcode);
    const decoded = decodePcode(loadFixture("prusaslicer"));

    expect(decoded.layers).toEqual(parsed.layers);
    expect(decoded.bounds.minX).toBeCloseTo(parsed.bounds.minX, 2);
    expect(decoded.bounds.maxZ).toBeCloseTo(parsed.bounds.maxZ, 3);
  });

  test("preserves feature types and travel breaks", () => {
    const model = decodePcode(loadFixture("prusaslicer"));
    expect(Array.from(model.featureType).some((f) => f === FEATURE_OUTER_WALL)).toBe(true);
    expect(Array.from(model.isTravel).some((t) => t === 1)).toBe(true);
    expect(Array.from(model.isTravel).some((t) => t === 0)).toBe(true);
  });

  test("assigns every point to a layer present in the layer list", () => {
    const model = decodePcode(loadFixture("prusaslicer"));
    const maxLayer = Math.max(...model.layer);
    expect(maxLayer).toBe(model.layers.length - 1);
  });

  test("rejects a buffer with a bad magic", () => {
    const bytes = new Uint8Array(loadFixture("prusaslicer").slice(0));
    bytes[0] = 0x58;
    expect(() => decodePcode(bytes.buffer)).toThrow(PcodeDecodeError);
  });

  test("rejects the old ptp1 magic — the reset is clean, not dual-format", () => {
    const bytes = new Uint8Array(loadFixture("prusaslicer"));
    // Overwrite PCOD with the retired PTP1 magic.
    bytes[0] = 0x50; bytes[1] = 0x54; bytes[2] = 0x50; bytes[3] = 0x31; // "PTP1"
    expect(() => decodePcode(bytes.buffer)).toThrow(PcodeDecodeError);
  });

  test("ignores unknown flag bits instead of rejecting", () => {
    const bytes = new Uint8Array(loadFixture("prusaslicer"));
    const before = decodePcode(bytes.buffer.slice(0)).count;
    // Set every bit of the reserved u16 flags field (offset 6-7).
    bytes[6] = 0xff; bytes[7] = 0xff;
    const after = decodePcode(bytes.buffer);
    expect(after.count).toBe(before);
  });

  test("rejects an unsupported version", () => {
    const bytes = new Uint8Array(loadFixture("prusaslicer").slice(0));
    bytes[4] = 99;
    expect(() => decodePcode(bytes.buffer)).toThrow(/version/i);
  });

  test("rejects truncated data", () => {
    const full = loadFixture("prusaslicer");
    expect(() => decodePcode(full.slice(0, 8))).toThrow(PcodeDecodeError);
  });

  test("decodes a view embedded at a non-zero offset inside a larger buffer identically to a standalone decode", () => {
    // Today's one caller always hands decodePcode a fresh ArrayBuffer starting
    // at byte 0, but the decoder must not assume that: it should honour a
    // view's byteOffset/byteLength rather than reading from the start of the
    // underlying buffer.
    const standalone = loadFixture("prusaslicer");
    const artifact = new Uint8Array(standalone);

    const PADDING_BEFORE = 37;
    const PADDING_AFTER = 11;
    const padded = new Uint8Array(PADDING_BEFORE + artifact.length + PADDING_AFTER);
    padded.fill(0xaa); // non-zero filler so a byteOffset bug can't accidentally read zeros as valid data
    padded.set(artifact, PADDING_BEFORE);
    const embeddedView = new Uint8Array(padded.buffer, PADDING_BEFORE, artifact.length);

    expect(decodePcode(embeddedView)).toEqual(decodePcode(standalone));
  });

  // ─── Value-level decoding ───
  //
  // The shape assertions above would pass on a decoder that got byte order,
  // zigzag signs, or per-layer attribute state wrong. These pin the actual
  // numbers against the geometry in fixtures/gcode/prusaslicer.gcode.

  test("decodes coordinates and per-point attributes exactly", () => {
    const model = decodePcode(loadFixture("prusaslicer"));

    // The skirt loop on layer 0: absolute start, then three deltas. A
    // sign error in the zigzag decoder shows up here immediately.
    const xy = (i: number) => [model.xs[i], model.ys[i]];
    expect([0, 1, 2, 3, 4].map(xy)).toEqual([
      [10, 10],
      [30, 10],
      [30, 30],
      [10, 30],
      [10, 10],
    ]);
    // Skirt/Brim, travel in, then extrusion at the slower feedrate.
    expect(model.isTravel[0]).toBe(1);
    expect(model.feedrate[0]).toBe(9000);
    expect(model.featureType[0]).toBe(9);
    expect(model.isTravel[1]).toBe(0);
    expect(model.feedrate[1]).toBe(1800);
    expect(model.featureType[1]).toBe(9);
    // Bead geometry comes from SET_BEAD as a little-endian u16 pair; a
    // byte-order slip would read 0.42/0.2 as something else entirely.
    expect(model.width[0]).toBeCloseTo(0.42, 3);
    expect(model.height[0]).toBeCloseTo(0.2, 3);
  });

  test("restarts attribute state at each layer boundary", () => {
    // Layer 1 re-emits its own SET_* opcodes. If the decoder leaked layer 0's
    // trailing state (infill, featureType 3) instead, the first extrusion of
    // layer 1 would not read as the seam start the parser recorded.
    const model = decodePcode(loadFixture("prusaslicer"));
    const layer1: number[] = [];
    for (let i = 0; i < model.count; i++) {
      if (model.layer[i] === 1) layer1.push(i);
    }

    expect(layer1.length).toBeGreaterThan(0);
    // `zs` is a Float32Array (see types.ts), so the stored value is the
    // float32 nearest 0.4, not the f64 literal — compare against the same
    // narrowing rather than the exact double.
    expect(layer1.every((i) => model.zs[i] === Math.fround(0.4))).toBe(true);

    const second = layer1[1];
    expect(model.xs[second]).toBe(15);
    expect(model.ys[second]).toBe(15);
    expect(model.featureType[second]).toBe(FEATURE_SEAM_START);

    const last = layer1[layer1.length - 1];
    expect(model.xs[last]).toBe(24);
    expect(model.ys[last]).toBe(24);
    expect(model.featureType[last]).toBe(FEATURE_TOP_SURFACE);
  });

  test("keeps the layers array independent of the Z its points sit at", () => {
    // The format carries two deliberately non-redundant notions of layer Z,
    // decoded independently rather than one derived from the other (see
    // pcode-decoder.ts's "carried verbatim" comment). Every layer-change
    // comment style the parser understands now records its Z from an
    // explicit `; Z_HEIGHT:` or, failing that, the new layer's first
    // extruding move (see parser.ts's `awaitingLayerZ`), so for this fixture
    // the two notions agree today: `layers` reads [0.2, 0.4], the same Z the
    // points sit at. They did not always — this used to be exactly where
    // PrusaSlicer's `;LAYER_CHANGE` path lagged one layer behind the
    // geometry, reading `layers` as [0, 0.2] while the points already sat at
    // 0.2/0.4. The decoder must still carry `layers` verbatim rather than
    // derive it from `zs`, or a future divergence would be silently
    // swallowed instead of surfaced.
    const model = decodePcode(loadFixture("prusaslicer"));

    expect(model.layers).toEqual([0.2, 0.4]);
    // `zs` is a Float32Array; compare against the float32-narrowed values
    // rather than the f64 literals (see the `zs` narrowing note above).
    expect([...new Set(model.zs)].sort((a, b) => a - b)).toEqual([
      Math.fround(0.2),
      Math.fround(0.4),
    ]);
  });

  // ─── Malformed input ───
  //
  // These bytes arrive over the network, so every hostile shape must throw a
  // typed error rather than hang, over-allocate, or return wrong data.

  /** Builds a 44-byte `pcode` v1 header with the given counts, plus a raw stream. */
  function synthetic(
    counts: { layerCount: number; pointCount: number; layerZCount: number },
    table: Array<[number, number, number, number]> = [],
    stream: number[] = [],
  ): ArrayBuffer {
    const HEADER_LEN = 44;
    const LAYER_ENTRY_LEN = 16;
    const buf = new ArrayBuffer(HEADER_LEN + table.length * LAYER_ENTRY_LEN + stream.length);
    const view = new DataView(buf);
    view.setUint32(0, 0x444f4350, true); // "PCOD"
    view.setUint16(4, 1, true); // version
    view.setUint32(32, counts.layerCount, true);
    view.setUint32(36, counts.pointCount, true);
    view.setUint32(40, counts.layerZCount, true);
    table.forEach(([layerId, zUm, offset, count], i) => {
      const base = HEADER_LEN + i * LAYER_ENTRY_LEN;
      view.setUint32(base, layerId, true);
      view.setUint32(base + 4, zUm, true);
      view.setUint32(base + 8, offset, true);
      view.setUint32(base + 12, count, true);
    });
    new Uint8Array(buf).set(stream, HEADER_LEN + table.length * LAYER_ENTRY_LEN);
    return buf;
  }

  test("rejects a hostile layer-Z count instead of allocating for it", () => {
    const buf = synthetic({ layerCount: 0, pointCount: 0, layerZCount: 0xffffffff });
    expect(() => decodePcode(buf)).toThrow(PcodeDecodeError);
  });

  test("rejects a hostile layer count instead of allocating for it", () => {
    const buf = synthetic({ layerCount: 0xffffffff, pointCount: 0, layerZCount: 0 });
    expect(() => decodePcode(buf)).toThrow(PcodeDecodeError);
  });

  test("rejects a hostile point count instead of allocating for it", () => {
    // Unlike the layer arrays, the point arrays are now eager typed-array
    // allocations (`new Float32Array(pointCount)`, ...): a huge pointCount
    // must be rejected before it ever reaches `new Float32Array`, not just
    // eventually fail the `written !== pointCount` check.
    const buf = synthetic({ layerCount: 0, pointCount: 0xffffffff, layerZCount: 0 });
    expect(() => decodePcode(buf)).toThrow(PcodeDecodeError);
  });

  test("rejects an unknown opcode", () => {
    const buf = synthetic(
      { layerCount: 1, pointCount: 1, layerZCount: 0 },
      [[0, 200, 0, 1]],
      [0x99],
    );
    expect(() => decodePcode(buf)).toThrow(/opcode/i);
  });

  test("terminates on a polyline whose declared length outruns the buffer", () => {
    // A hostile point count inside the stream must fail on the exhausted
    // buffer rather than spinning: the loop is bounded by bytes, not by the
    // declared count. 0x0fffffff points, no coordinate bytes to back them.
    const OP_POLYLINE = 0x06;
    const buf = synthetic(
      { layerCount: 1, pointCount: 1, layerZCount: 0 },
      [[0, 200, 0, 1]],
      [OP_POLYLINE, 0xff, 0xff, 0xff, 0x7f],
    );
    expect(() => decodePcode(buf)).toThrow(PcodeDecodeError);
  });

  test("rejects a layer table offset that points past the stream", () => {
    // A one-byte stream is enough to clear the pointCount allocation guard
    // (pointCount 1 <= 1 remaining byte) without backing the huge offset —
    // this must still fail via the reader running off the end of the
    // buffer, not the allocation guard, so both stay independently tested.
    const buf = synthetic(
      { layerCount: 1, pointCount: 1, layerZCount: 0 },
      [[0, 200, 0xffff, 1]],
      [0],
    );
    expect(() => decodePcode(buf)).toThrow(PcodeDecodeError);
  });

  test("rejects a layer table with a duplicate layer id", () => {
    // The layer table's `layerId` field: two entries claiming the same layer
    // id can only come from a corrupted or hostile stream (a well-formed
    // encoder's BTreeMap keys are unique) and must be rejected rather than
    // silently giving "the same" layer two different Z values.
    const HEADER_LEN = 44;
    const LAYER_ENTRY_LEN = 16;
    const buf = new ArrayBuffer(HEADER_LEN + LAYER_ENTRY_LEN * 2);
    const view = new DataView(buf);
    view.setUint32(0, 0x444f4350, true); // "PCOD"
    view.setUint16(4, 1, true); // version
    view.setUint32(32, 2, true); // layerCount
    view.setUint32(36, 0, true); // pointCount
    view.setUint32(40, 0, true); // layerZCount
    // Both entries declare layerId 0.
    view.setUint32(HEADER_LEN, 0, true);
    view.setUint32(HEADER_LEN + LAYER_ENTRY_LEN, 0, true);
    expect(() => decodePcode(buf)).toThrow(/duplicate layer id/i);
  });
});

describe("decodePcode point-layer parity with the source parse", () => {
  // C1 regression, closing the structural gap that hid it: the codec
  // round-trip used to be pinned against exactly one fixture (prusaslicer),
  // which is the one fixture whose source layer ids happen to already be
  // 0-based and contiguous. Every fixture the parsers are pinned to
  // (parity.test.ts) must also be pinned through the codec, or a codec bug
  // like this one stays invisible.
  //
  // Derived from the fixture directory rather than hardcoded, so a new
  // fixture enrolls itself instead of silently going untested.
  const FIXTURE_NAMES = readdirSync(path.join(FIXTURES, "pcode"))
    .filter((f) => f.endsWith(".pcode"))
    .map((f) => f.slice(0, -".pcode".length))
    .sort();

  test("discovers at least one fixture", () => {
    // A directory that silently reads as empty would make every test below
    // vacuously pass zero assertions — exactly the failure mode discovery is
    // meant to close.
    expect(FIXTURE_NAMES.length).toBeGreaterThan(0);
  });

  for (const name of FIXTURE_NAMES) {
    test(`${name}: decoded point-layers match the source parse`, () => {
      const gcode = readFileSync(path.join(FIXTURES, "gcode", `${name}.gcode`), "utf8");
      const sourceLayers = new Set(parseGcode(gcode).layer);

      const decodedLayers = new Set(decodePcode(loadFixture(name)).layer);

      expect(decodedLayers).toEqual(sourceLayers);
    });
  }
});
