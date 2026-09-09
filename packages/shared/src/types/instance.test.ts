import { describe, expect, it } from "vitest";
import { clampToNearestPreset, clampToPresetCeiling, DAILY_RETENTION_PRESETS } from "./instance.js";

describe("clampToPresetCeiling", () => {
  it("passes an exact preset value through unchanged", () => {
    expect(clampToPresetCeiling(3, DAILY_RETENTION_PRESETS)).toBe(3);
    expect(clampToPresetCeiling(7, DAILY_RETENTION_PRESETS)).toBe(7);
    expect(clampToPresetCeiling(14, DAILY_RETENTION_PRESETS)).toBe(14);
  });

  it("rounds a below-minimum value up to the smallest preset", () => {
    expect(clampToPresetCeiling(1, DAILY_RETENTION_PRESETS)).toBe(3);
  });

  it("rounds UP even when nearest-by-distance would round down (KEWL-4636 P1)", () => {
    // Nearest-by-distance would pick 7 for both (distance 2 and 1
    // respectively) -- that silently shortens the requested retention.
    // The ceiling clamp must never do that: it always picks the smallest
    // preset that is >= the requested value.
    expect(clampToPresetCeiling(8, DAILY_RETENTION_PRESETS)).toBe(14);
    expect(clampToPresetCeiling(9, DAILY_RETENTION_PRESETS)).toBe(14);
    // Sanity: confirm clampToNearestPreset actually WOULD round these down,
    // so the contrast above is real and not a stale assumption about its
    // behavior.
    expect(clampToNearestPreset(8, DAILY_RETENTION_PRESETS)).toBe(7);
    expect(clampToNearestPreset(9, DAILY_RETENTION_PRESETS)).toBe(7);
  });

  it("caps at the largest preset when the requested value exceeds every preset", () => {
    expect(clampToPresetCeiling(30, DAILY_RETENTION_PRESETS)).toBe(14);
    expect(clampToPresetCeiling(3650, DAILY_RETENTION_PRESETS)).toBe(14);
  });

  it("works against an unsorted preset list", () => {
    expect(clampToPresetCeiling(5, [14, 3, 7] as const)).toBe(7);
  });
});
