import { describe, it, expect } from "vitest";
import {
  splitPower,
  splitKw,
  formatWatts,
  splitEnergy,
  formatPercent,
  signedPower,
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
  it("always formats kW with one decimal (no W switching)", () => {
    expect(splitKw(940)).toEqual({ value: "0.9", unit: "kW" });
    expect(splitKw(7)).toEqual({ value: "0.0", unit: "kW" });
    expect(splitKw(5930)).toEqual({ value: "5.9", unit: "kW" });
    expect(splitKw(12000)).toEqual({ value: "12.0", unit: "kW" });
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

describe("signedPower", () => {
  it("signs negative values only", () => {
    expect(signedPower(1200)).toBe("1.20 kW");
    expect(signedPower(-340)).toBe("-340 W");
    expect(signedPower(0)).toBe("0 W");
  });
});
