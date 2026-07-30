import type {
  InputPropertyControl,
  InputPropertyValue,
  SourceKind,
} from "../types/obs";

export type RuntimePlatform = "macos" | "windows" | "unknown";

export function runtimePlatform(): RuntimePlatform {
  const agent = navigator.userAgent.toLowerCase();
  if (agent.includes("windows")) return "windows";
  if (agent.includes("macintosh") || agent.includes("mac os")) return "macos";
  return "unknown";
}

const kindCandidates: Record<
  RuntimePlatform,
  Record<SourceKind, string[]>
> = {
  macos: {
    camera: [
      "macos-avcapture-fast",
      "macos-avcapture",
      "av_capture_input",
    ],
    microphone: ["coreaudio_input_capture"],
    display: ["screen_capture", "macos_screen_capture"],
    window: ["screen_capture", "macos_screen_capture"],
    browser: ["browser_source"],
    image: ["image_source"],
    media: ["ffmpeg_source"],
  },
  windows: {
    camera: ["dshow_input"],
    microphone: ["wasapi_input_capture"],
    display: ["monitor_capture"],
    window: ["window_capture"],
    browser: ["browser_source"],
    image: ["image_source"],
    media: ["ffmpeg_source"],
  },
  unknown: {
    camera: ["v4l2_input"],
    microphone: ["pulse_input_capture", "alsa_input_capture"],
    display: ["xshm_input", "pipewire-desktop-capture-source"],
    window: ["xcomposite_input", "pipewire-desktop-capture-source"],
    browser: ["browser_source"],
    image: ["image_source"],
    media: ["ffmpeg_source"],
  },
};

export function inputKindCandidates(
  kind: SourceKind,
  platform: RuntimePlatform = runtimePlatform(),
): string[] {
  return kindCandidates[platform][kind];
}

export function normalizeObsPlatform(platform?: string): RuntimePlatform {
  if (platform === "macos") return "macos";
  if (platform === "windows") return "windows";
  return "unknown";
}

export function sourceKindFromInputKind(inputKind?: string): SourceKind | "unknown" {
  if (!inputKind) return "unknown";
  for (const platform of Object.values(kindCandidates)) {
    for (const [sourceKind, candidates] of Object.entries(platform)) {
      if (candidates.includes(inputKind)) return sourceKind as SourceKind;
    }
  }
  return "unknown";
}

const listProperties: Record<SourceKind, string[]> = {
  camera: [
    "device",
    "video_device_id",
    "resolution",
    "res_type",
    "frame_interval",
    "supported_format",
    "buffering",
  ],
  microphone: ["device_id", "device"],
  display: ["display", "screen", "monitor", "method"],
  window: ["window", "capture_window", "priority", "method"],
  browser: [],
  image: [],
  media: [],
};

export function listPropertyCandidates(kind: SourceKind | "unknown"): string[] {
  return kind === "unknown" ? [] : listProperties[kind];
}

export function propertyLabel(name: string): string {
  const labels: Record<string, string> = {
    device: "Device",
    device_id: "Device",
    video_device_id: "Video device",
    resolution: "Resolution",
    res_type: "Resolution type",
    frame_interval: "Frame rate",
    supported_format: "Format",
    buffering: "Buffering",
    display: "Display",
    screen: "Display",
    monitor: "Display",
    window: "Window",
    capture_window: "Window",
    priority: "Window matching",
    method: "Capture method",
  };
  return labels[name] ?? name.replace(/_/g, " ");
}

export function sourceSettings(
  kind: SourceKind,
  detail: { url?: string; path?: string; settings?: Record<string, unknown> },
): Record<string, unknown> {
  const settings = { ...(detail.settings ?? {}) };
  if (kind === "browser") {
    return {
      url: detail.url ?? "https://kick.com",
      width: 1920,
      height: 1080,
      ...settings,
    };
  }
  if (kind === "image") return { file: detail.path ?? "", ...settings };
  if (kind === "media") {
    return {
      local_file: detail.path ?? "",
      is_local_file: true,
      looping: false,
      ...settings,
    };
  }
  return settings;
}

export function toPropertyControl(
  name: string,
  value: unknown,
  options: Array<{
    itemName?: string;
    itemValue?: InputPropertyValue;
    itemEnabled?: boolean;
  }>,
): InputPropertyControl {
  return {
    name,
    label: propertyLabel(name),
    type: "list",
    value:
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
        ? value
        : null,
    options: options
      .filter((option) => option.itemValue !== undefined)
      .map((option) => ({
        label: option.itemName ?? String(option.itemValue),
        value: option.itemValue!,
        enabled: option.itemEnabled !== false,
      })),
  };
}
