import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseGcode } from "./parser";

const FIXTURES = path.resolve(__dirname, "../fixtures");
const EDGE = 20;

const NAMES = [
  "prusaslicer", "orca", "cura", "simplify3d",
  "no-layer-comments", "zhop", "idex",
];

/**
 * Same digest shape the Rust generator writes. Field names are camelCase to
 * match `ParitySummary`'s serde renaming — the two sides compare against one
 * golden file, so the shapes must agree exactly.
 */
function summarize(text: string) {
  const m = parseGcode(text);
  const point = (i: number) => ({
    x: m.xs[i], y: m.ys[i], z: m.zs[i],
    isTravel: m.isTravel[i] === 1,
    layer: m.layer[i], tool: m.tool[i], feedrate: m.feedrate[i],
    featureType: m.featureType[i], width: m.width[i], height: m.height[i],
  });
  const featureCounts: Record<string, number> = {};
  for (let i = 0; i < m.count; i++) {
    const k = String(m.featureType[i]);
    featureCounts[k] = (featureCounts[k] ?? 0) + 1;
  }
  const head = [];
  for (let i = 0; i < Math.min(EDGE, m.count); i++) head.push(point(i));
  const tail = [];
  for (let i = Math.max(0, m.count - EDGE); i < m.count; i++) tail.push(point(i));
  return {
    pointCount: m.count,
    layers: m.layers,
    bounds: m.bounds,
    featureCounts,
    head,
    tail,
  };
}

/**
 * The Rust side's `ParityPoint`/`ParityBounds` (services/procontrol-core/src/
 * preview/parity.rs) store `f32` fields, and its parser reads gcode text
 * straight into `f32` (`parser.rs`, `trimmed[..i].parse::<f32>()`). serde_json
 * serializes those with the shortest decimal that round-trips to that exact
 * f32 bit pattern (e.g. the f32 nearest 0.42 becomes the text "0.42"), and on
 * the Rust side `serde_json::from_str` deserializes straight back into `f32`
 * — a lossless round trip.
 *
 * JSON has one number type, so `JSON.parse` here always yields a JS
 * `number` (f64): the double nearest to the *decimal text*, not the double
 * that exactly represents the original f32 bit pattern. Those differ for
 * almost every non-integer value (`Math.fround(0.4) !== 0.4`), which is why
 * fractional fields (z, width, height) would otherwise mismatch while
 * integer ones (x, y, tool, layer, feedrate) happen to match. `Math.fround`
 * narrows the parsed goldens back down to f32 precision, mirroring what
 * Rust's type-directed deserialization does for free — this recovers the
 * bit-exact-at-f32-precision comparison the test is actually meant to make,
 * without touching the fixtures or the parser.
 */
function froundDeep(value: unknown): unknown {
  if (typeof value === "number") return Math.fround(value);
  if (Array.isArray(value)) return value.map(froundDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = froundDeep(v);
    }
    return out;
  }
  return value;
}

describe("parser parity with the Rust implementation", () => {
  for (const name of NAMES) {
    test(`${name} matches the committed golden`, () => {
      const gcode = readFileSync(path.join(FIXTURES, "gcode", `${name}.gcode`), "utf8");
      const goldenRaw = JSON.parse(readFileSync(path.join(FIXTURES, "parity", `${name}.json`), "utf8"));
      expect(summarize(gcode)).toEqual(froundDeep(goldenRaw));
    });
  }
});
