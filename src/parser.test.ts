import { describe, test, expect, it } from "vitest";
import { parseGcode } from "./parser";
import {
  FEATURE_OUTER_WALL,
  FEATURE_INNER_WALL,
  FEATURE_INFILL,
  FEATURE_SEAM_START,
  FEATURE_SKIRT_BRIM,
  FEATURE_SOLID_INFILL,
  FEATURE_TOP_SURFACE,
  FEATURE_SUPPORT,
  FEATURE_BRIDGE,
  FEATURE_UNKNOWN,
} from "./features";

describe("parseGcode", () => {
  test("classifies feature types in the documented order", () => {
    const m = parseGcode(
      [
        ";TYPE:External perimeter", "G1 X1 Y1 Z0.2 E1",
        ";TYPE:Perimeter", "G1 X2 Y2 E2",
        ";TYPE:Top solid infill", "G1 X3 Y3 E3",
        ";TYPE:Solid infill", "G1 X4 Y4 E4",
        ";TYPE:Bridge infill", "G1 X5 Y5 E5",
        ";TYPE:Support material", "G1 X6 Y6 E6",
        ";TYPE:Internal infill", "G1 X7 Y7 E7",
        ";TYPE:Prime tower", "G1 X8 Y8 E8",
        ";TYPE:Nonsense", "G1 X9 Y9 E9",
      ].join("\n"),
    );
    expect(Array.from(m.featureType)).toEqual([
      FEATURE_OUTER_WALL, FEATURE_INNER_WALL, FEATURE_TOP_SURFACE,
      FEATURE_SOLID_INFILL, FEATURE_BRIDGE, FEATURE_SUPPORT,
      FEATURE_INFILL, FEATURE_SKIRT_BRIM, FEATURE_UNKNOWN,
    ]);
  });

  test("marks travel and extrusion moves", () => {
    const m = parseGcode("G1 X0 Y0 Z0.2\nG1 X10 Y0 E1\nG0 X20 Y0\n");
    expect(m.count).toBe(3);
    expect(Array.from(m.isTravel)).toEqual([1, 0, 1]);
    expect(m.xs[1]).toBeCloseTo(10, 5);
  });

  test("counts layers from slicer comments", () => {
    const m = parseGcode(
      ";LAYER_CHANGE\nG1 Z0.2\nG1 X1 Y1 E1\n;LAYER_CHANGE\nG1 Z0.4\nG1 X2 Y2 E2\n",
    );
    expect(m.layer[m.count - 1]).toBe(1);
  });

  test("falls back to Z-change detection and ignores a Z-hop", () => {
    const m = parseGcode("G1 X0 Y0 Z0.2 E1\nG0 X5 Y5 Z1.0\nG1 X6 Y6 Z0.2 E2\n");
    expect(m.layer[m.count - 1]).toBe(0);
    expect(m.layers.length).toBe(1);
  });

  test("tracks tool changes", () => {
    const m = parseGcode("G1 X1 Y1 Z0.2 E1\nT1\nG1 X2 Y2 E2\n");
    expect(Array.from(m.tool)).toEqual([0, 1]);
  });

  test("marks seam start after a retract on an outer wall", () => {
    const m = parseGcode(
      ";TYPE:External perimeter\nG1 X1 Y1 Z0.2 E1\nG1 X5 Y5 E-1\nG1 X6 Y6 E3\n",
    );
    expect(m.featureType[2]).toBe(FEATURE_SEAM_START);
  });

  test("honours relative positioning and G92", () => {
    const m = parseGcode("G92 X10 Y10\nG91\nG1 X5 Y0 E1\n");
    expect(m.xs[0]).toBeCloseTo(15, 5);
    expect(m.ys[0]).toBeCloseTo(10, 5);
  });

  test("reads width and height comments", () => {
    const m = parseGcode(";WIDTH:0.5\n;HEIGHT:0.3\nG1 X1 Y1 Z0.3 E1\n");
    expect(m.width[0]).toBeCloseTo(0.5, 5);
    expect(m.height[0]).toBeCloseTo(0.3, 5);
  });

  test("ignores lowercase axis letters, like the original parser", () => {
    const m = parseGcode("G1 x10 Y5 Z0.2 E1\n");
    expect(m.xs[0]).toBe(0);
    expect(m.ys[0]).toBeCloseTo(5, 5);
  });

  test("reads a numeric prefix and rejects inf/nan, like JS parseFloat", () => {
    const m = parseGcode("G1 X10abc Y5 Z0.2 E1\nG1 Xinf Y6 E2\n");
    expect(m.xs[0]).toBeCloseTo(10, 5);
    expect(m.xs[1]).toBeCloseTo(10, 5); // "inf" rejected, X keeps its value
  });

  test("arrays are trimmed to count", () => {
    const m = parseGcode("G1 X1 Y1 Z0.2 E1\nG1 X2 Y2 E2\n");
    expect(m.count).toBe(2);
    expect(m.xs.length).toBe(2);
    expect(m.featureType.length).toBe(2);
  });

  test("an empty program yields no points and bed-sized default bounds", () => {
    const m = parseGcode("");
    expect(m.count).toBe(0);
    expect(m.bounds).toEqual({ minX: 0, maxX: 220, minY: 0, maxY: 220, minZ: 0, maxZ: 100 });
  });

  test("grows the typed-array storage past the initial capacity and preserves earlier data", () => {
    // INITIAL_CAPACITY is 1024; N is chosen comfortably past it so PointBuilder.grow()
    // runs twice (1024 -> 2048 -> 4096), exercising the capacity-doubling path that
    // every fixture and every other unit test (max 17 points) never touches.
    const N = 2500;
    const lines = ["G1 X0 Y0 Z0.2 E1"];
    for (let i = 1; i < N; i++) {
      lines.push(`G1 X${i} Y${i * 2} E${i + 1}`);
    }
    const m = parseGcode(lines.join("\n") + "\n");

    expect(m.count).toBe(N);
    for (const arr of [m.xs, m.ys, m.zs, m.layer, m.featureType, m.tool, m.isTravel, m.feedrate, m.width, m.height]) {
      expect(arr.length).toBe(N);
    }

    const expectPoint = (i: number) => {
      expect(m.xs[i]).toBeCloseTo(i, 5);
      expect(m.ys[i]).toBeCloseTo(i * 2, 5);
      expect(m.zs[i]).toBeCloseTo(0.2, 5);
      expect(m.layer[i]).toBe(0);
      expect(m.tool[i]).toBe(0);
      expect(m.isTravel[i]).toBe(0);
      // No ;TYPE:/F/;WIDTH:/;HEIGHT: comment anywhere in the input, so these
      // stay at their initial defaults for every point — checked per-index
      // (not just `.length`) so a grow() that dropped one of these four
      // copies would leave indices 0..1023 zeroed and still be caught.
      // Defaults are 0 (absent means absent — see `parseGcode`'s `width`/
      // `height` declarations); this test only cares that grow() carries
      // whatever the initial value is through unmolested, not what that
      // value happens to be.
      expect(m.featureType[i]).toBe(FEATURE_UNKNOWN);
      expect(m.feedrate[i]).toBe(1500);
      expect(m.width[i]).toBe(0);
      expect(m.height[i]).toBe(0);
    };

    expectPoint(0);        // written before any growth, cap 1024
    expectPoint(1000);     // still in the first-generation (1024) buffer
    expectPoint(1024);     // first index written right after the 1024 -> 2048 grow
    expectPoint(2000);     // in the second-generation (2048) buffer
    expectPoint(2048);     // first index written right after the 2048 -> 4096 grow
    expectPoint(N - 1);    // 2499, last index, in the final (4096-capacity) buffer
  });
});

describe("Protype slicer markers", () => {
  it("counts layers from `; CHANGE_LAYER`", () => {
    const src = [
      "; CHANGE_LAYER", "; Z_HEIGHT: 0.2", "G1 X1 Y1 Z0.2 E1",
      "; CHANGE_LAYER", "; Z_HEIGHT: 0.4", "G1 X2 Y2 Z0.4 E2",
    ].join("\n");
    const m = parseGcode(src);
    expect(Array.from(m.layer.slice(0, m.count))).toEqual([0, 1]);
  });

  it("reads `; FEATURE:` as the line type", () => {
    const src = "; FEATURE: Outer wall\nG1 X1 Y1 Z0.2 E1\n; FEATURE: Sparse infill\nG1 X2 Y2 E2\n";
    const m = parseGcode(src);
    expect(m.featureType[0]).toBe(FEATURE_OUTER_WALL);
    expect(m.featureType[1]).toBe(FEATURE_INFILL);
  });

  it("reads `; LAYER_HEIGHT:` as the layer height", () => {
    const m = parseGcode("; LAYER_HEIGHT: 0.3\nG1 X1 Y1 Z0.3 E1\n");
    expect(m.height[0]).toBeCloseTo(0.3, 6);
  });

  it("ignores config-block keys that only look like markers", () => {
    // Orca writes its settings into the file as `key = value` comments; the
    // sample job carries `; layer_height = 0.2` in its header. Only the colon
    // separates a setting from a marker.
    const src = "; layer_height = 0.2\n; change_layer_gcode = G1 X0\nG1 X1 Y1 Z0.2 E1\n";
    const m = parseGcode(src);
    expect(m.height[0]).toBe(0);
    expect(m.layer[0]).toBe(0);
  });

  it("leaves width and height at zero when the file states neither", () => {
    const m = parseGcode("G1 X1 Y1 Z0.2 E1\n");
    expect(m.width[0]).toBe(0);
    expect(m.height[0]).toBe(0);
  });

  // The two tests below port Task 1's "Fix round 1" regression tests
  // (services/procontrol-core/src/preview/parser.rs). They are not in the
  // original task brief, which predates that fix round, but the brief's own
  // "Interfaces" section defers to "whichever `; Z_HEIGHT:` approach Task 1
  // chose" — the state-then-record design below is that approach, and these
  // are the tests that actually distinguish it from the guess-then-correct
  // design that regressed `layers`. The "counts layers" test above only
  // checks per-point `layer`, which the pre-existing Z-delta fallback
  // heuristic derives correctly on its own for this monotonically-increasing
  // fixture even when the marker path is broken — so it would stay green
  // either way and cannot catch the collapse these two are written for.
  it("records each layer's own Z height instead of collapsing into one", () => {
    // Regression: `; CHANGE_LAYER` must not push a *guess* (the previous
    // move's Z) into `layers`, relying on the following `; Z_HEIGHT:` to
    // overwrite it. Once a second layer's guess collides with the first
    // layer's already-corrected value, dedup silently skips the push, and
    // the correction that follows clobbers the wrong (shared) slot — every
    // layer beyond the first collapses into one entry.
    const src = [
      "; CHANGE_LAYER", "; Z_HEIGHT: 0.2", "G1 X1 Y1 Z0.2 E1",
      "; CHANGE_LAYER", "; Z_HEIGHT: 0.4", "G1 X2 Y2 Z0.4 E2",
    ].join("\n");
    const m = parseGcode(src);
    expect(m.layers).toEqual([0.2, 0.4]);
  });

  it("falls back to the move's Z when `; CHANGE_LAYER` has no `; Z_HEIGHT:` comment", () => {
    // Not every Orca-derived profile is guaranteed to pair `; CHANGE_LAYER`
    // with `; Z_HEIGHT:`. Absent that comment, the new layer's first
    // extruding move must still end up recorded, rather than left out of
    // `layers` entirely.
    const src = [
      "; CHANGE_LAYER", "G1 X1 Y1 Z0.2 E1",
      "; CHANGE_LAYER", "G1 X2 Y2 Z0.4 E2",
    ].join("\n");
    const m = parseGcode(src);
    expect(m.layers).toEqual([0.2, 0.4]);
    expect(Array.from(m.layer.slice(0, m.count))).toEqual([0, 1]);
  });
});
