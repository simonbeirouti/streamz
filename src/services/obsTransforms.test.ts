import { describe, expect, it } from "vitest";
import { placementTransform } from "./obsTransforms";

describe("placementTransform", () => {
  const source = {
    sourceWidth: 640,
    sourceHeight: 480,
    scaleX: 1,
    scaleY: 1,
  };

  it("fits and centers a 4:3 source on a 16:9 canvas", () => {
    expect(placementTransform(source, "fit")).toMatchObject({
      positionX: 240,
      positionY: 0,
      scaleX: 2.25,
      scaleY: 2.25,
      alignment: 5,
      boundsType: "OBS_BOUNDS_NONE",
    });
  });

  it("fills and centers while preserving aspect ratio", () => {
    expect(placementTransform(source, "fill")).toMatchObject({
      positionX: 0,
      positionY: -180,
      scaleX: 3,
      scaleY: 3,
    });
  });

  it("centers using the current scale", () => {
    expect(
      placementTransform({ ...source, scaleX: 2, scaleY: 2 }, "center"),
    ).toMatchObject({
      positionX: 320,
      positionY: 60,
      scaleX: 2,
      scaleY: 2,
    });
  });

  it("resets all transform and crop fields", () => {
    expect(placementTransform(source, "reset")).toMatchObject({
      positionX: 0,
      positionY: 0,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      cropTop: 0,
      cropBottom: 0,
      cropLeft: 0,
      cropRight: 0,
    });
  });

  it("refuses to place a source before OBS reports dimensions", () => {
    expect(() =>
      placementTransform({ ...source, sourceWidth: 0 }, "fit"),
    ).toThrow(/dimensions/i);
  });
});
