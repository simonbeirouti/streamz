import type {
  PlacementPreset,
  SceneItemTransform,
} from "../types/obs";

export const OBS_CANVAS_WIDTH = 1920;
export const OBS_CANVAS_HEIGHT = 1080;

export const defaultTransform: SceneItemTransform = {
  positionX: 0,
  positionY: 0,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
  sourceWidth: 0,
  sourceHeight: 0,
  width: 0,
  height: 0,
  cropTop: 0,
  cropBottom: 0,
  cropLeft: 0,
  cropRight: 0,
  boundsType: "OBS_BOUNDS_NONE",
  boundsWidth: 0,
  boundsHeight: 0,
  boundsAlignment: 0,
  cropToBounds: false,
  alignment: 5,
};

export function placementTransform(
  source: Pick<
    SceneItemTransform,
    "sourceWidth" | "sourceHeight" | "scaleX" | "scaleY"
  >,
  preset: PlacementPreset,
  canvasWidth = OBS_CANVAS_WIDTH,
  canvasHeight = OBS_CANVAS_HEIGHT,
): Partial<SceneItemTransform> {
  const width = source.sourceWidth;
  const height = source.sourceHeight;
  if (width <= 0 || height <= 0) {
    throw new Error("OBS has not reported this source's video dimensions yet.");
  }

  if (preset === "reset") {
    return {
      positionX: 0,
      positionY: 0,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      cropTop: 0,
      cropBottom: 0,
      cropLeft: 0,
      cropRight: 0,
      boundsType: "OBS_BOUNDS_NONE",
      boundsWidth: 0,
      boundsHeight: 0,
      boundsAlignment: 0,
      cropToBounds: false,
      alignment: 5,
    };
  }

  const currentScale = Math.abs(source.scaleX || 1);
  const scale =
    preset === "fit"
      ? Math.min(canvasWidth / width, canvasHeight / height)
      : preset === "fill"
        ? Math.max(canvasWidth / width, canvasHeight / height)
        : currentScale;
  const scaledWidth = width * scale;
  const scaledHeight = height * scale;

  return {
    positionX: (canvasWidth - scaledWidth) / 2,
    positionY: (canvasHeight - scaledHeight) / 2,
    scaleX: scale,
    scaleY: scale,
    boundsType: "OBS_BOUNDS_NONE",
    boundsWidth: 0,
    boundsHeight: 0,
    boundsAlignment: 0,
    alignment: 5,
    ...(preset === "fit" || preset === "fill"
      ? {
          rotation: 0,
          cropTop: 0,
          cropBottom: 0,
          cropLeft: 0,
          cropRight: 0,
          cropToBounds: false,
        }
      : {}),
  };
}
