import { describe, it, expect } from "vitest";
import {
  splitPower,
  splitKw,
  formatWatts,
  splitEnergy,
  formatPercent,
} from "./format";

describe("splitPower", () => {
  it("keeps watts under 1kW", () => {
    expect(splitPower(940)).toEqual({ value: "940", unit: "W" });
    expect(splitPower(0)).toEqual({ value: "0", unit: "W" });
  });
  it("scales to kW with adaptive precision", () => {
    expect(splitPower(3965)).toEqual({ value: "3.96", unit: "kW" });
    expect(splitPower(12000)).toEqual({ value: "12.0", unit: "kW" });
  });
});

describe("splitKw", () => {
  it("formats kW (no W switching) and trims a trailing .0", () => {
    expect(splitKw(940)).toEqual({ value: "0.9", unit: "kW" });
    expect(splitKw(5930)).toEqual({ value: "5.9", unit: "kW" });
    // Trailing .0 dropped, like the panel app ("5" not "5.0").
    expect(splitKw(7)).toEqual({ value: "0", unit: "kW" });
    expect(splitKw(5000)).toEqual({ value: "5", unit: "kW" });
    expect(splitKw(12000)).toEqual({ value: "12", unit: "kW" });
  });
});

describe("formatWatts", () => {
  it("adds thousands separators", () => {
    expect(formatWatts(3965)).toBe("3,965 W");
  });
});

describe("splitEnergy", () => {
  it("whole numbers at or above 10 kWh", () => {
    expect(splitEnergy(42)).toEqual({ value: "42", unit: "kWh" });
  });
  it("one decimal below 10 kWh", () => {
    expect(splitEnergy(5.4)).toEqual({ value: "5.4", unit: "kWh" });
  });
  it("scales to MWh", () => {
    expect(splitEnergy(2500)).toEqual({ value: "2.5", unit: "MWh" });
  });
});

describe("formatPercent", () => {
  it("formats fractions", () => {
    expect(formatPercent(0.74)).toBe("74%");
    expect(formatPercent(0.293, 1)).toBe("29.3%");
  });
});

