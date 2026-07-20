import { describe, test, expect } from "vitest";
import { parseGcode } from "./parser";
import { toLines } from "./to-lines";
import { FEATURE_OUTER_WALL } from "./features";

describe("toLines", () => {
  test("produces one object per point, in order", () => {
    const arrays = parseGcode(";TYPE:External perimeter\nG1 X1 Y2 Z0.2 E1\nG0 X3 Y4\n");
    const parsed = toLines(arrays);
    expect(parsed.lines.length).toBe(arrays.count);
    expect(parsed.lines[0].x).toBeCloseTo(1, 5);
    expect(parsed.lines[0].y).toBeCloseTo(2, 5);
    expect(parsed.lines[0].featureType).toBe(FEATURE_OUTER_WALL);
    expect(parsed.lines[1].x).toBeCloseTo(3, 5);
  });

  test("turns isTravel back into a boolean", () => {
    const parsed = toLines(parseGcode("G1 X1 Y1 Z0.2 E1\nG0 X2 Y2\n"));
    expect(parsed.lines[0].isTravel).toBe(false);
    expect(parsed.lines[1].isTravel).toBe(true);
  });

  test("fills e with 0 — no renderer reads it", () => {
    const parsed = toLines(parseGcode("G1 X1 Y1 Z0.2 E5\n"));
    expect(parsed.lines[0].e).toBe(0);
  });

  test("passes layers and bounds through unchanged", () => {
    const arrays = parseGcode("G1 X1 Y1 Z0.2 E1\nG1 X2 Y2 Z0.4 E2\n");
    const parsed = toLines(arrays);
    expect(parsed.layers).toEqual(arrays.layers);
    expect(parsed.bounds).toEqual(arrays.bounds);
  });

  test("passes tool, feedrate, width, and height through unchanged", () => {
    const arrays = parseGcode("T1\n;WIDTH:0.5\n;HEIGHT:0.3\nG1 X1 Y1 Z0.2 F1200 E1\n");
    const parsed = toLines(arrays);
    expect(parsed.lines[0].tool).toBe(1);
    expect(parsed.lines[0].feedrate).toBeCloseTo(1200, 5);
    expect(parsed.lines[0].width).toBeCloseTo(0.5, 5);
    expect(parsed.lines[0].height).toBeCloseTo(0.3, 5);
  });

  test("an empty parse yields no lines", () => {
    expect(toLines(parseGcode("")).lines).toEqual([]);
  });
});
