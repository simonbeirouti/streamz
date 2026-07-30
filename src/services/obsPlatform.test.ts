import { describe, expect, it } from "vitest";
import {
  propertyLabel,
  sourceKindFromInputKind,
  sourceSettings,
} from "./obsPlatform";

describe("OBS platform adapters", () => {
  it.each([
    ["macos-avcapture-fast", "camera"],
    ["macos-avcapture", "camera"],
    ["dshow_input", "camera"],
    ["coreaudio_input_capture", "microphone"],
    ["screen_capture", "display"],
    ["browser_source", "browser"],
    ["image_source", "image"],
    ["ffmpeg_source", "media"],
  ])("maps %s to %s", (inputKind, sourceKind) => {
    expect(sourceKindFromInputKind(inputKind)).toBe(sourceKind);
  });

  it("builds safe browser and media defaults", () => {
    expect(
      sourceSettings("browser", { url: "https://example.com" }),
    ).toMatchObject({
      url: "https://example.com",
      width: 1920,
      height: 1080,
    });
    expect(sourceSettings("media", { path: "/tmp/test.mp4" })).toMatchObject({
      local_file: "/tmp/test.mp4",
      is_local_file: true,
      looping: false,
    });
  });

  it("provides readable property labels", () => {
    expect(propertyLabel("video_device_id")).toBe("Video device");
    expect(propertyLabel("custom_field")).toBe("custom field");
  });
});
