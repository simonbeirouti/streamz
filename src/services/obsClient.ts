import OBSWebSocket, {
  EventSubscription,
  type OBSEventTypes,
} from "obs-websocket-js";
import {
  inputKindCandidates,
  listPropertyCandidates,
  normalizeObsPlatform,
  sourceKindFromInputKind,
  sourceSettings,
  toPropertyControl,
} from "./obsPlatform";
import {
  defaultTransform,
  placementTransform,
} from "./obsTransforms";
import type {
  AddSourceDraft,
  CreateInputDraft,
  InputAudioState,
  InputDescriptor,
  InputPropertyControl,
  InputPropertyValue,
  KickStreamConfig,
  MediaAction,
  MediaState,
  ObsCapabilityMap,
  ObsEntityRef,
  OutputState,
  PlacementPreset,
  RecordingState,
  ReplayBufferState,
  Scene,
  SceneItemTransform,
  Source,
  SourceKind,
  SourceReferenceReport,
  StreamState,
  StudioSnapshot,
  TransitionState,
} from "../types/obs";

export type StudioEvent =
  | { type: "refresh"; reason: string }
  | { type: "stream"; state: StreamState }
  | { type: "recording"; state: RecordingState }
  | { type: "replay"; state: ReplayBufferState }
  | { type: "virtual-camera"; active: boolean }
  | { type: "meters"; meters: Array<{ inputName: string; level: number }> }
  | { type: "closed" }
  | { type: "error"; message: string };

type Listener = (event: StudioEvent) => void;
type JsonRecord = Record<string, unknown>;

const wait = (milliseconds: number) =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));

const blankStreamState: StreamState = {
  active: false,
  reconnecting: false,
  durationMs: 0,
  bytesSent: 0,
  skippedFrames: 0,
  totalFrames: 0,
  congestion: 0,
  lastError: null,
};

const blankRecordingState: RecordingState = {
  active: false,
  paused: false,
  durationMs: 0,
  bytes: 0,
  path: null,
  lastError: null,
};

const blankReplayState: ReplayBufferState = {
  active: false,
  lastSavedPath: null,
  lastError: null,
};

function entityArgs(
  prefix: "scene" | "input" | "source",
  entity: ObsEntityRef,
): Record<string, string> {
  if (entity.uuid) return { [`${prefix}Uuid`]: entity.uuid };
  return { [`${prefix}Name`]: entity.name };
}

function streamStateFromStatus(status: {
  outputActive: boolean;
  outputReconnecting: boolean;
  outputDuration: number;
  outputBytes: number;
  outputSkippedFrames: number;
  outputTotalFrames: number;
  outputCongestion: number;
}): StreamState {
  return {
    active: status.outputActive,
    reconnecting: status.outputReconnecting,
    durationMs: status.outputDuration,
    bytesSent: status.outputBytes,
    skippedFrames: status.outputSkippedFrames,
    totalFrames: status.outputTotalFrames,
    congestion: status.outputCongestion,
    lastError: null,
  };
}

function normalizeTransform(raw: JsonRecord): SceneItemTransform {
  return {
    ...defaultTransform,
    ...(raw as unknown as Partial<SceneItemTransform>),
  };
}

function writableTransform(
  transform: Partial<SceneItemTransform>,
): Partial<SceneItemTransform> {
  const writableKeys: Array<keyof SceneItemTransform> = [
    "positionX",
    "positionY",
    "rotation",
    "scaleX",
    "scaleY",
    "cropTop",
    "cropBottom",
    "cropLeft",
    "cropRight",
    "boundsType",
    "boundsWidth",
    "boundsHeight",
    "boundsAlignment",
    "cropToBounds",
    "alignment",
  ];
  return Object.fromEntries(
    writableKeys.flatMap((key) =>
      transform[key] === undefined ||
      ((key === "boundsWidth" || key === "boundsHeight") &&
        Number(transform[key]) < 1)
        ? []
        : [[key, transform[key]]],
    ),
  ) as Partial<SceneItemTransform>;
}

function uniqueInputName(base: string, names: Set<string>): string {
  if (!names.has(base)) return base;
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${base} ${index}`;
    if (!names.has(candidate)) return candidate;
  }
  throw new Error("Could not generate a unique OBS source name.");
}

export class ObsStudioClient {
  private readonly obs: OBSWebSocket;
  private readonly listeners = new Set<Listener>();
  private sessionProfile: string | null = null;
  private workspaceReady = false;
  private recordingPath: string | null = null;
  private capabilities: ObsCapabilityMap | null = null;
  private eventsBound = false;
  private lastRecordingPath: string | null = null;
  private lastReplayPath: string | null = null;

  constructor(obs?: OBSWebSocket) {
    this.obs = obs ?? new OBSWebSocket();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: StudioEvent) {
    for (const listener of this.listeners) listener(event);
  }

  async connect(url: string, password: string, recordingPath: string) {
    this.bindEvents();
    await this.obs.connect(url, password, {
      eventSubscriptions:
        EventSubscription.All |
        EventSubscription.InputVolumeMeters |
        EventSubscription.SceneItemTransformChanged,
    });
    this.capabilities = null;
    this.recordingPath = recordingPath;
    if (!this.workspaceReady) {
      await this.ensureWorkspace(recordingPath);
      this.workspaceReady = true;
    }
    await this.getCapabilities();
  }

  async disconnectSocket() {
    await this.obs.disconnect().catch(() => undefined);
    this.capabilities = null;
  }

  async disconnect() {
    await this.cleanupSession().catch(() => undefined);
    await this.obs.disconnect();
    this.capabilities = null;
    this.workspaceReady = false;
    this.recordingPath = null;
  }

  private bindEvents() {
    if (this.eventsBound) return;
    this.eventsBound = true;
    const refreshEvents: Array<keyof OBSEventTypes> = [
      "CurrentProgramSceneChanged",
      "CurrentPreviewSceneChanged",
      "SceneCreated",
      "SceneRemoved",
      "SceneNameChanged",
      "SceneListChanged",
      "SceneItemCreated",
      "SceneItemRemoved",
      "SceneItemEnableStateChanged",
      "SceneItemLockStateChanged",
      "SceneItemListReindexed",
      "SceneItemTransformChanged",
      "SceneItemSelected",
      "InputCreated",
      "InputRemoved",
      "InputNameChanged",
      "InputMuteStateChanged",
      "InputVolumeChanged",
      "InputAudioBalanceChanged",
      "InputAudioSyncOffsetChanged",
      "InputAudioMonitorTypeChanged",
      "InputAudioTracksChanged",
      "InputSettingsChanged",
      "MediaInputPlaybackStarted",
      "MediaInputPlaybackEnded",
      "MediaInputActionTriggered",
      "SourceFilterCreated",
      "SourceFilterRemoved",
      "SourceFilterNameChanged",
      "SourceFilterEnableStateChanged",
      "SourceFilterListReindexed",
      "CurrentSceneTransitionChanged",
      "CurrentSceneTransitionDurationChanged",
      "StudioModeStateChanged",
    ];
    for (const eventName of refreshEvents) {
      this.obs.on(eventName, () =>
        this.emit({ type: "refresh", reason: eventName }),
      );
    }
    this.obs.on("StreamStateChanged", async (event) => {
      const state = await this.getStreamState().catch(() => ({
        ...blankStreamState,
        active: event.outputActive,
        lastError: event.outputState,
      }));
      this.emit({ type: "stream", state });
    });
    this.obs.on("RecordStateChanged", (event) => {
      if (event.outputPath) this.lastRecordingPath = event.outputPath;
      const normalizedState = event.outputState.toUpperCase();
      this.emit({
        type: "recording",
        state: {
          ...blankRecordingState,
          active: event.outputActive,
          paused: normalizedState.includes("PAUSED"),
          path: this.lastRecordingPath,
          lastError: normalizedState.includes("ERROR")
            ? event.outputState
            : null,
        },
      });
    });
    this.obs.on("ReplayBufferSaved", (event) => {
      this.lastReplayPath = event.savedReplayPath;
      this.emit({
        type: "replay",
        state: {
          ...blankReplayState,
          active: true,
          lastSavedPath: event.savedReplayPath,
        },
      });
    });
    this.obs.on("ReplayBufferStateChanged", async (event) => {
      const state = await this.getReplayBufferState().catch(() => ({
        ...blankReplayState,
        active: event.outputActive,
        lastSavedPath: this.lastReplayPath,
        lastError: event.outputState,
      }));
      this.emit({ type: "replay", state });
    });
    this.obs.on("VirtualcamStateChanged", (event) => {
      this.emit({ type: "virtual-camera", active: event.outputActive });
    });
    this.obs.on("InputVolumeMeters", (event) => {
      const inputs = event.inputs as unknown as Array<{
        inputName: string;
        inputLevelsMul: number[][];
      }>;
      this.emit({
        type: "meters",
        meters: inputs.map((input) => ({
          inputName: input.inputName,
          level: Math.max(
            0,
            Math.min(1, input.inputLevelsMul[0]?.[1] ?? 0),
          ),
        })),
      });
    });
    this.obs.on("ConnectionClosed", () => this.emit({ type: "closed" }));
    this.obs.on("ConnectionError", (error) =>
      this.emit({ type: "error", message: error.message }),
    );
  }

  private async ensureWorkspace(recordingPath: string) {
    const collections = await this.obs.call("GetSceneCollectionList");
    if (!collections.sceneCollections.includes("Streamz")) {
      await this.obs.call("CreateSceneCollection", {
        sceneCollectionName: "Streamz",
      });
    } else if (collections.currentSceneCollectionName !== "Streamz") {
      await this.obs.call("SetCurrentSceneCollection", {
        sceneCollectionName: "Streamz",
      });
    }

    const profiles = await this.obs.call("GetProfileList");
    if (!profiles.profiles.includes("Streamz")) {
      await this.obs.call("CreateProfile", { profileName: "Streamz" });
    }
    if (profiles.currentProfileName !== "Streamz") {
      await this.obs.call("SetCurrentProfile", { profileName: "Streamz" });
    }

    if (!this.sessionProfile) {
      const refreshedProfiles = await this.obs.call("GetProfileList");
      for (const profile of refreshedProfiles.profiles) {
        if (profile.startsWith("Streamz Session-")) {
          await this.obs
            .call("RemoveProfile", { profileName: profile })
            .catch(() => undefined);
        }
      }

      this.sessionProfile = `Streamz Session-${Date.now()}`;
      await this.obs.call("CreateProfile", {
        profileName: this.sessionProfile,
      });
    }

    const activeProfiles = await this.obs.call("GetProfileList");
    if (activeProfiles.currentProfileName !== this.sessionProfile) {
      await this.obs.call("SetCurrentProfile", {
        profileName: this.sessionProfile,
      });
    }
    await this.applyKickOutputPreset(recordingPath);

    const scenes = await this.obs.call("GetSceneList");
    if (scenes.scenes.length === 0) {
      await this.obs.call("CreateScene", { sceneName: "Main" });
    }
  }

  private async applyKickOutputPreset(recordingPath = this.recordingPath ?? "") {
    await this.obs.call("SetVideoSettings", {
      baseWidth: 1920,
      baseHeight: 1080,
      outputWidth: 1920,
      outputHeight: 1080,
      fpsNumerator: 30,
      fpsDenominator: 1,
    });
    const parameters: Array<[string, string, string]> = [
      ["Output", "Mode", "Simple"],
      ["SimpleOutput", "VBitrate", "6000"],
      ["SimpleOutput", "ABitrate", "160"],
      ["SimpleOutput", "StreamEncoder", "x264"],
      ["SimpleOutput", "FilePath", recordingPath],
      ["SimpleOutput", "RecFormat2", "hybrid_mp4"],
      ["SimpleOutput", "RecQuality", "Stream"],
      ["SimpleOutput", "RecEncoder", "x264"],
      ["SimpleOutput", "RecRB", "true"],
      ["SimpleOutput", "RecRBTime", "20"],
      ["SimpleOutput", "RecRBSize", "512"],
      ["SimpleOutput", "RecRBPrefix", "Replay"],
      ["AdvOut", "TrackIndex", "1"],
      ["Video", "FPSType", "0"],
      ["Audio", "SampleRate", "48000"],
      ["Audio", "ChannelSetup", "Stereo"],
    ];
    await Promise.all(
      parameters.map(([parameterCategory, parameterName, parameterValue]) =>
        this.obs.call("SetProfileParameter", {
          parameterCategory,
          parameterName,
          parameterValue,
        }),
      ),
    );
  }

  async getCapabilities(): Promise<ObsCapabilityMap> {
    if (this.capabilities) return this.capabilities;
    const [version, kinds] = await Promise.all([
      this.obs.call("GetVersion"),
      this.obs.call("GetInputKindList", { unversioned: false }),
    ]);
    this.capabilities = {
      obsVersion: version.obsVersion,
      websocketVersion: version.obsWebSocketVersion,
      rpcVersion: version.rpcVersion,
      platform: version.platform,
      requests: version.availableRequests,
      inputKinds: kinds.inputKinds,
    };
    return this.capabilities;
  }

  supports(request: string): boolean {
    return this.capabilities?.requests.includes(request) ?? false;
  }

  async getScenes(): Promise<{
    scenes: Scene[];
    currentProgramScene: ObsEntityRef | null;
    currentPreviewScene: ObsEntityRef | null;
  }> {
    const response = await this.obs.call("GetSceneList");
    const rawScenes = response.scenes as unknown as Array<{
      sceneName: string;
      sceneUuid?: string;
      sceneIndex?: number;
    }>;
    return {
      currentProgramScene: response.currentProgramSceneName
        ? {
            name: response.currentProgramSceneName,
            uuid: response.currentProgramSceneUuid ?? undefined,
          }
        : null,
      currentPreviewScene: response.currentPreviewSceneName
        ? {
            name: response.currentPreviewSceneName,
            uuid: response.currentPreviewSceneUuid ?? undefined,
          }
        : null,
      scenes: rawScenes.map((scene, index) => ({
        name: scene.sceneName,
        uuid: scene.sceneUuid,
        index: scene.sceneIndex ?? index,
      })),
    };
  }

  async getStudioSnapshot(scene?: ObsEntityRef): Promise<StudioSnapshot> {
    const [capabilities, sceneResult, transitions, outputs] = await Promise.all([
      this.getCapabilities(),
      this.getScenes(),
      this.getTransitionState(),
      this.getOutputState(),
    ]);
    const activeScene =
      sceneResult.scenes.find((item) => item.uuid && item.uuid === scene?.uuid) ??
      sceneResult.scenes.find((item) => item.name === scene?.name) ??
      sceneResult.scenes.find(
        (item) => item.uuid === sceneResult.currentProgramScene?.uuid,
      ) ??
      sceneResult.scenes.find(
        (item) => item.name === sceneResult.currentProgramScene?.name,
      ) ??
      sceneResult.scenes[0];
    const sources = activeScene ? await this.getSources(activeScene) : [];
    return {
      capabilities,
      scenes: sceneResult.scenes,
      currentProgramScene: sceneResult.currentProgramScene,
      sources,
      transitions: {
        ...transitions,
        previewScene: sceneResult.currentPreviewScene,
      },
      outputs,
    };
  }

  async createScene(
    name: string,
    target: "program" | "preview" = "program",
  ): Promise<ObsEntityRef> {
    const created = await this.obs.call("CreateScene", { sceneName: name });
    const scene = { name, uuid: created.sceneUuid };
    await this.obs.call(
      target === "preview"
        ? "SetCurrentPreviewScene"
        : "SetCurrentProgramScene",
      {
      ...entityArgs("scene", scene),
      },
    );
    return scene;
  }

  async renameScene(scene: ObsEntityRef, newSceneName: string) {
    await this.obs.call("SetSceneName", {
      ...entityArgs("scene", scene),
      newSceneName,
    });
  }

  async removeScene(scene: ObsEntityRef) {
    await this.obs.call("RemoveScene", entityArgs("scene", scene));
  }

  async setCurrentProgramScene(scene: ObsEntityRef) {
    await this.obs.call("SetCurrentProgramScene", entityArgs("scene", scene));
  }

  async setCurrentPreviewScene(scene: ObsEntityRef) {
    await this.obs.call("SetCurrentPreviewScene", entityArgs("scene", scene));
  }

  async getSources(scene: ObsEntityRef): Promise<Source[]> {
    const response = await this.obs.call(
      "GetSceneItemList",
      entityArgs("scene", scene),
    );
    const sceneItems = response.sceneItems as unknown as Array<{
      sceneItemId: number;
      sceneItemIndex: number;
      sourceName: string;
      sourceUuid?: string;
      inputKind?: string;
      sceneItemEnabled: boolean;
      sceneItemLocked: boolean;
      sceneItemTransform: JsonRecord;
    }>;
    const sources = await Promise.all(
      sceneItems.map(async (item) => {
        const input = { name: item.sourceName, uuid: item.sourceUuid };
        const [audio, media, blend] = await Promise.all([
          this.getInputAudioState(input).catch(() => null),
          this.getMediaState(input).catch(() => null),
          this.obs
            .call("GetSceneItemBlendMode", {
              ...entityArgs("scene", scene),
              sceneItemId: item.sceneItemId,
            })
            .then((result) => result.sceneItemBlendMode)
            .catch(() => "OBS_BLEND_NORMAL"),
        ]);
        return {
          ...input,
          sceneItemId: item.sceneItemId,
          sceneItemIndex: item.sceneItemIndex,
          inputKind: item.inputKind,
          sourceKind: sourceKindFromInputKind(item.inputKind),
          enabled: item.sceneItemEnabled,
          locked: item.sceneItemLocked,
          blendMode: blend,
          transform: normalizeTransform(item.sceneItemTransform),
          audio,
          media,
        } satisfies Source;
      }),
    );
    return [...sources].sort(
      (left, right) => right.sceneItemIndex - left.sceneItemIndex,
    );
  }

  async getInputDescriptors(): Promise<InputDescriptor[]> {
    const response = await this.obs.call("GetInputList");
    const inputs = response.inputs as unknown as Array<{
      inputName: string;
      inputUuid?: string;
      inputKind: string;
      unversionedInputKind?: string;
    }>;
    return Promise.all(
      inputs.map(async (input) => {
        const settings = await this.obs.call("GetInputSettings", {
          ...(input.inputUuid
            ? { inputUuid: input.inputUuid }
            : { inputName: input.inputName }),
        });
        const sourceKind = sourceKindFromInputKind(input.inputKind);
        const properties = await this.getInputProperties(
          { name: input.inputName, uuid: input.inputUuid },
          sourceKind,
          settings.inputSettings as JsonRecord,
        );
        return {
          name: input.inputName,
          uuid: input.inputUuid,
          inputKind: input.inputKind,
          unversionedInputKind:
            input.unversionedInputKind ?? input.inputKind,
          sourceKind,
          settings: settings.inputSettings as JsonRecord,
          properties,
        };
      }),
    );
  }

  async resolveInputKind(sourceKind: SourceKind): Promise<string> {
    const available = new Set((await this.getCapabilities()).inputKinds);
    const platform = normalizeObsPlatform(this.capabilities?.platform);
    const kind = inputKindCandidates(sourceKind, platform).find((candidate) =>
      available.has(candidate),
    );
    if (kind) return kind;

    const unversioned = await this.obs.call("GetInputKindList", {
      unversioned: true,
    });
    const unversionedSet = new Set(unversioned.inputKinds);
    const fallback = inputKindCandidates(sourceKind, platform).find((candidate) =>
      unversionedSet.has(candidate),
    );
    if (fallback) return fallback;
    throw new Error(
      `OBS ${this.capabilities?.obsVersion ?? ""} does not provide a compatible ${sourceKind} input.`,
    );
  }

  async addSource(scene: ObsEntityRef, draft: AddSourceDraft): Promise<Source> {
    const resolvedKind = await this.resolveInputKind(draft.kind);
    const createDraft: CreateInputDraft = {
      kind: draft.kind,
      name: draft.name,
      scene,
      inputKind: resolvedKind,
      settings: sourceSettings(draft.kind, draft),
      placement: draft.placement ?? "fit",
    };
    return this.createInput(createDraft);
  }

  async createInput(draft: CreateInputDraft): Promise<Source> {
    const existing = await this.obs.call("GetInputList");
    const names = new Set(
      (existing.inputs as unknown as Array<{ inputName: string }>).map(
        (input) => input.inputName,
      ),
    );
    const inputName = uniqueInputName(draft.name, names);
    const created = await this.obs.call("CreateInput", {
      ...entityArgs("scene", draft.scene),
      inputName,
      inputKind:
        draft.inputKind ?? (await this.resolveInputKind(draft.kind)),
      inputSettings: draft.settings as never,
      sceneItemEnabled: false,
    });
    const input = { name: inputName, uuid: created.inputUuid };
    try {
      if (
        (draft.kind === "camera" || draft.kind === "microphone") &&
        Object.keys(draft.settings).length === 0
      ) {
        await this.selectFirstAvailableProperty(input, draft.kind);
      }
      await this.setSourceEnabled(draft.scene, created.sceneItemId, true);
      if (draft.kind !== "microphone") {
        const transform = await this.waitForSourceTransform(
          draft.scene,
          created.sceneItemId,
        );
        if (transform) {
          await this.setPlacement(
            draft.scene,
            created.sceneItemId,
            transform,
            draft.placement,
          );
        } else {
          // Camera and capture sources can take several seconds to publish their
          // first frame. Creation has succeeded, so keep the input and finish
          // placement in the background instead of deleting it as a 0x0 source.
          void this.placeSourceWhenReady(
            draft.scene,
            created.sceneItemId,
            draft.placement,
          ).catch(() => undefined);
        }
      }
      const sources = await this.getSources(draft.scene);
      const source = sources.find(
        (item) => item.sceneItemId === created.sceneItemId,
      );
      if (!source) throw new Error("OBS created the input but did not return it.");
      return source;
    } catch (error) {
      await this.obs
        .call("RemoveInput", { inputUuid: created.inputUuid })
        .catch(() => undefined);
      throw error;
    }
  }

  private async selectFirstAvailableProperty(
    input: ObsEntityRef,
    kind: SourceKind,
  ) {
    const settings = await this.obs.call(
      "GetInputSettings",
      entityArgs("input", input),
    );
    const controls = await this.getInputProperties(
      input,
      kind,
      settings.inputSettings as JsonRecord,
    );
    const device = controls.find(
      (control) =>
        ["device", "device_id", "video_device_id"].includes(control.name) &&
        control.options.some((option) => option.enabled),
    );
    const usableOption = device?.options.find(
      (item) =>
        item.enabled &&
        (kind !== "camera" ||
          (item.value !== "" && item.value !== null && item.value !== false)),
    );
    if (!device || !usableOption) {
      throw new Error(
        `OBS could not find an available ${kind} device. Check system permissions and whether another app is using it.`,
      );
    }
    await this.setInputSettings(input, {
      [device.name]: usableOption.value,
      ...(kind === "camera" && device.name === "device"
        ? { device_name: usableOption.label }
        : {}),
    });

    if (kind === "camera") {
      // macos-avcapture-fast exposes formats only after a device is selected.
      // Selecting a format is what makes the source start producing frames.
      await wait(100);
      const refreshed = await this.obs.call(
        "GetInputSettings",
        entityArgs("input", input),
      );
      const dependentControls = await this.getInputProperties(
        input,
        kind,
        refreshed.inputSettings as JsonRecord,
      );
      const format = dependentControls.find(
        (control) =>
          ["supported_format", "resolution", "frame_interval"].includes(
            control.name,
          ) && control.options.some((item) => item.enabled && item.value !== ""),
      );
      const formatOption =
        format?.options.find(
          (item) =>
            item.enabled &&
            /1920\s*[x×]\s*1080/i.test(item.label) &&
            /30(?:\.0+)?\s*(?:fps)?/i.test(item.label),
        ) ??
        format?.options.find((item) => item.enabled && item.value !== "");
      if (format && formatOption) {
        await this.setInputProperty(input, format.name, formatOption.value);
      }
    }
  }

  private async waitForSourceTransform(
    scene: ObsEntityRef,
    sceneItemId: number,
    attempts = 30,
  ): Promise<SceneItemTransform | null> {
    let last = defaultTransform;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const response = await this.obs.call("GetSceneItemTransform", {
        ...entityArgs("scene", scene),
        sceneItemId,
      });
      last = normalizeTransform(response.sceneItemTransform as JsonRecord);
      if (last.sourceWidth > 0 && last.sourceHeight > 0) return last;
      await wait(100);
    }
    return null;
  }

  private async placeSourceWhenReady(
    scene: ObsEntityRef,
    sceneItemId: number,
    placement: PlacementPreset,
  ) {
    const transform = await this.waitForSourceTransform(scene, sceneItemId, 150);
    if (!transform) return;
    await this.setPlacement(scene, sceneItemId, transform, placement).catch(
      () => undefined,
    );
  }

  async getInputProperties(
    input: ObsEntityRef,
    kind: SourceKind | "unknown",
    knownSettings?: JsonRecord,
  ): Promise<InputPropertyControl[]> {
    const settings =
      knownSettings ??
      ((
        await this.obs.call("GetInputSettings", entityArgs("input", input))
      ).inputSettings as JsonRecord);
    const controls = (
      await Promise.all(
        listPropertyCandidates(kind).map(async (propertyName) => {
          const result = await this.obs
            .call("GetInputPropertiesListPropertyItems", {
              ...entityArgs("input", input),
              propertyName,
            })
            .catch(() => null);
          if (!result) return null;
          return toPropertyControl(
            propertyName,
            settings[propertyName],
            result.propertyItems as never,
          );
        }),
      )
    ).filter((control): control is InputPropertyControl => control !== null);

    if (kind === "browser") {
      controls.push(
        {
          name: "url",
          label: "URL",
          type: "text",
          value: String(settings.url ?? ""),
          options: [],
        },
        {
          name: "width",
          label: "Width",
          type: "number",
          value: Number(settings.width ?? 1920),
          options: [],
        },
        {
          name: "height",
          label: "Height",
          type: "number",
          value: Number(settings.height ?? 1080),
          options: [],
        },
        {
          name: "css",
          label: "Custom CSS",
          type: "text",
          value: String(settings.css ?? ""),
          options: [],
        },
      );
    }
    if (kind === "image") {
      controls.push({
        name: "file",
        label: "Image file",
        type: "path",
        value: String(settings.file ?? ""),
        options: [],
      });
    }
    if (kind === "media") {
      controls.push(
        {
          name: "local_file",
          label: "Media file",
          type: "path",
          value: String(settings.local_file ?? ""),
          options: [],
        },
        {
          name: "looping",
          label: "Loop",
          type: "boolean",
          value: Boolean(settings.looping),
          options: [],
        },
      );
    }
    return controls;
  }

  async setInputProperty(
    input: ObsEntityRef,
    propertyName: string,
    value: InputPropertyValue,
  ) {
    await this.setInputSettings(input, { [propertyName]: value });
  }

  async setInputSettings(
    input: ObsEntityRef,
    inputSettings: Record<string, InputPropertyValue>,
  ) {
    await this.obs.call("SetInputSettings", {
      ...entityArgs("input", input),
      inputSettings,
      overlay: true,
    });
  }

  async renameSource(input: ObsEntityRef, newInputName: string) {
    await this.obs.call("SetInputName", {
      ...entityArgs("input", input),
      newInputName,
    });
  }

  async duplicateSourceReference(
    scene: ObsEntityRef,
    sceneItemId: number,
  ): Promise<number> {
    const result = await this.obs.call("DuplicateSceneItem", {
      ...entityArgs("scene", scene),
      sceneItemId,
      ...(scene.uuid
        ? { destinationSceneUuid: scene.uuid }
        : { destinationSceneName: scene.name }),
    });
    return result.sceneItemId;
  }

  async duplicateInput(
    scene: ObsEntityRef,
    source: Source,
  ): Promise<Source> {
    const [inputSettings, inputs] = await Promise.all([
      this.obs.call("GetInputSettings", entityArgs("input", source)),
      this.obs.call("GetInputList"),
    ]);
    const names = new Set(
      (inputs.inputs as unknown as Array<{ inputName: string }>).map(
        (input) => input.inputName,
      ),
    );
    const name = uniqueInputName(`${source.name} Copy`, names);
    const created = await this.obs.call("CreateInput", {
      ...entityArgs("scene", scene),
      inputName: name,
      inputKind: inputSettings.inputKind,
      inputSettings: inputSettings.inputSettings,
      sceneItemEnabled: source.enabled,
    });
    await this.setSourceTransform(scene, created.sceneItemId, source.transform);
    const list = await this.getSources(scene);
    const duplicate = list.find(
      (item) => item.sceneItemId === created.sceneItemId,
    );
    if (!duplicate) throw new Error("OBS did not return the duplicated input.");
    return duplicate;
  }

  async getSourceReferenceReport(
    input: ObsEntityRef,
  ): Promise<SourceReferenceReport> {
    const { scenes } = await this.getScenes();
    const references = (
      await Promise.all(
        scenes.map(async (scene) => {
          const response = await this.obs.call(
            "GetSceneItemList",
            entityArgs("scene", scene),
          );
          return (
            response.sceneItems as unknown as Array<{
              sceneItemId: number;
              sourceName: string;
              sourceUuid?: string;
            }>
          )
            .filter((item) =>
              input.uuid
                ? item.sourceUuid === input.uuid
                : item.sourceName === input.name,
            )
            .map((item) => ({ scene, sceneItemId: item.sceneItemId }));
        }),
      )
    ).flat();
    return { input, references, shared: references.length > 1 };
  }

  async removeSource(
    scene: ObsEntityRef,
    source: Source,
    mode: "scene" | "everywhere",
  ) {
    if (mode === "everywhere") {
      await this.obs.call("RemoveInput", entityArgs("input", source));
      return;
    }
    await this.obs.call("RemoveSceneItem", {
      ...entityArgs("scene", scene),
      sceneItemId: source.sceneItemId,
    });
  }

  async setSourceEnabled(
    scene: ObsEntityRef,
    sceneItemId: number,
    sceneItemEnabled: boolean,
  ) {
    await this.obs.call("SetSceneItemEnabled", {
      ...entityArgs("scene", scene),
      sceneItemId,
      sceneItemEnabled,
    });
  }

  async setSourceLocked(
    scene: ObsEntityRef,
    sceneItemId: number,
    sceneItemLocked: boolean,
  ) {
    await this.obs.call("SetSceneItemLocked", {
      ...entityArgs("scene", scene),
      sceneItemId,
      sceneItemLocked,
    });
  }

  async setSourceIndex(
    scene: ObsEntityRef,
    sceneItemId: number,
    sceneItemIndex: number,
  ) {
    await this.obs.call("SetSceneItemIndex", {
      ...entityArgs("scene", scene),
      sceneItemId,
      sceneItemIndex,
    });
  }

  async setSourceTransform(
    scene: ObsEntityRef,
    sceneItemId: number,
    transform: Partial<SceneItemTransform>,
  ) {
    await this.obs.call("SetSceneItemTransform", {
      ...entityArgs("scene", scene),
      sceneItemId,
      sceneItemTransform: writableTransform(transform) as never,
    });
  }

  async setPlacement(
    scene: ObsEntityRef,
    sceneItemId: number,
    current: SceneItemTransform,
    preset: PlacementPreset,
  ) {
    await this.setSourceTransform(
      scene,
      sceneItemId,
      placementTransform(current, preset),
    );
  }

  async setSourceBlendMode(
    scene: ObsEntityRef,
    sceneItemId: number,
    sceneItemBlendMode: string,
  ) {
    await this.obs.call("SetSceneItemBlendMode", {
      ...entityArgs("scene", scene),
      sceneItemId,
      sceneItemBlendMode,
    });
  }

  async getInputAudioState(
    input: ObsEntityRef,
  ): Promise<InputAudioState> {
    const args = entityArgs("input", input);
    const [mute, volume, balance, sync, monitor, tracks] = await Promise.all([
      this.obs.call("GetInputMute", args),
      this.obs.call("GetInputVolume", args),
      this.obs.call("GetInputAudioBalance", args),
      this.obs.call("GetInputAudioSyncOffset", args),
      this.obs.call("GetInputAudioMonitorType", args),
      this.obs.call("GetInputAudioTracks", args),
    ]);
    return {
      muted: mute.inputMuted,
      volumeDb: volume.inputVolumeDb,
      volumeMul: volume.inputVolumeMul,
      balance: balance.inputAudioBalance,
      syncOffsetMs: sync.inputAudioSyncOffset,
      monitorType: monitor.monitorType,
      tracks: tracks.inputAudioTracks as Record<string, boolean>,
    };
  }

  async setInputMute(input: ObsEntityRef, inputMuted: boolean) {
    await this.obs.call("SetInputMute", {
      ...entityArgs("input", input),
      inputMuted,
    });
  }

  async setInputVolume(input: ObsEntityRef, inputVolumeDb: number) {
    await this.obs.call("SetInputVolume", {
      ...entityArgs("input", input),
      inputVolumeDb,
    });
  }

  async setInputAudioBalance(input: ObsEntityRef, inputAudioBalance: number) {
    await this.obs.call("SetInputAudioBalance", {
      ...entityArgs("input", input),
      inputAudioBalance,
    });
  }

  async setInputAudioSyncOffset(
    input: ObsEntityRef,
    inputAudioSyncOffset: number,
  ) {
    await this.obs.call("SetInputAudioSyncOffset", {
      ...entityArgs("input", input),
      inputAudioSyncOffset,
    });
  }

  async setInputAudioMonitorType(input: ObsEntityRef, monitorType: string) {
    await this.obs.call("SetInputAudioMonitorType", {
      ...entityArgs("input", input),
      monitorType,
    });
  }

  async setInputAudioTracks(
    input: ObsEntityRef,
    inputAudioTracks: Record<string, boolean>,
  ) {
    await this.obs.call("SetInputAudioTracks", {
      ...entityArgs("input", input),
      inputAudioTracks,
    });
  }

  async getMediaState(input: ObsEntityRef): Promise<MediaState> {
    const result = await this.obs.call(
      "GetMediaInputStatus",
      entityArgs("input", input),
    );
    return {
      state: result.mediaState,
      durationMs: result.mediaDuration ?? 0,
      cursorMs: result.mediaCursor ?? 0,
    };
  }

  async triggerMediaAction(input: ObsEntityRef, mediaAction: MediaAction) {
    await this.obs.call("TriggerMediaInputAction", {
      ...entityArgs("input", input),
      mediaAction,
    });
  }

  async setMediaCursor(input: ObsEntityRef, mediaCursor: number) {
    await this.obs.call("SetMediaInputCursor", {
      ...entityArgs("input", input),
      mediaCursor,
    });
  }

  async getTransitionState(): Promise<TransitionState> {
    const [list, current, studio] = await Promise.all([
      this.obs.call("GetSceneTransitionList"),
      this.obs.call("GetCurrentSceneTransition"),
      this.obs.call("GetStudioModeEnabled"),
    ]);
    const transitions = list.transitions as unknown as Array<{
      transitionName: string;
      transitionUuid?: string;
      transitionKind?: string;
      transitionConfigurable?: boolean;
    }>;
    return {
      available: transitions.map((transition) => ({
        name: transition.transitionName,
        uuid: transition.transitionUuid,
        kind: transition.transitionKind,
        configurable: transition.transitionConfigurable ?? false,
      })),
      current: current.transitionName,
      durationMs: current.transitionDuration ?? 300,
      studioModeEnabled: studio.studioModeEnabled,
      previewScene: null,
    };
  }

  async setStudioModeEnabled(studioModeEnabled: boolean) {
    await this.obs.call("SetStudioModeEnabled", { studioModeEnabled });
  }

  async setCurrentTransition(transitionName: string) {
    await this.obs.call("SetCurrentSceneTransition", { transitionName });
  }

  async setTransitionDuration(transitionDuration: number) {
    await this.obs.call("SetCurrentSceneTransitionDuration", {
      transitionDuration,
    });
  }

  async triggerTransition() {
    await this.obs.call("TriggerStudioModeTransition");
  }

  async openInputProperties(input: ObsEntityRef) {
    await this.obs.call(
      "OpenInputPropertiesDialog",
      entityArgs("input", input),
    );
  }

  async openInputFilters(input: ObsEntityRef) {
    await this.obs.call("OpenInputFiltersDialog", entityArgs("input", input));
  }

  async openInputInteract(input: ObsEntityRef) {
    await this.obs.call("OpenInputInteractDialog", entityArgs("input", input));
  }

  async startVirtualCamera() {
    await this.obs.call("StartVirtualCam");
  }

  async stopVirtualCamera() {
    await this.obs.call("StopVirtualCam");
  }

  async configureKick(config: KickStreamConfig) {
    await this.obs.call("SetStreamServiceSettings", {
      streamServiceType: "rtmp_custom",
      streamServiceSettings: {
        server: config.server,
        key: config.streamKey,
        use_auth: false,
      },
    });
  }

  async startStream(config: KickStreamConfig) {
    await this.configureKick(config);
    await this.obs.call("StartStream");
  }

  async stopStream() {
    await this.obs.call("StopStream");
    await this.clearStreamCredentials();
  }

  async getStreamState(): Promise<StreamState> {
    return streamStateFromStatus(await this.obs.call("GetStreamStatus"));
  }

  async getRecordingState(): Promise<RecordingState> {
    const result = await this.obs.call("GetRecordStatus");
    return {
      active: result.outputActive,
      paused: result.outputPaused,
      durationMs: result.outputDuration,
      bytes: result.outputBytes,
      path: this.lastRecordingPath,
      lastError: null,
    };
  }

  async startRecording() {
    await this.obs.call("StartRecord");
  }

  async stopRecording(): Promise<string> {
    const result = await this.obs.call("StopRecord");
    this.lastRecordingPath = result.outputPath;
    return result.outputPath;
  }

  async setRecordingPaused(paused: boolean) {
    await this.obs.call(paused ? "PauseRecord" : "ResumeRecord");
  }

  async getReplayBufferState(): Promise<ReplayBufferState> {
    const result = await this.obs.call("GetReplayBufferStatus");
    return {
      active: result.outputActive,
      lastSavedPath: this.lastReplayPath,
      lastError: null,
    };
  }

  async startReplayBuffer() {
    await this.obs.call("StartReplayBuffer");
  }

  async stopReplayBuffer() {
    await this.obs.call("StopReplayBuffer");
  }

  async saveReplayBuffer() {
    await this.obs.call("SaveReplayBuffer");
  }

  async getOutputState(): Promise<OutputState> {
    const [stream, recording, replayBuffer, virtualCamera] = await Promise.all([
      this.getStreamState().catch(() => blankStreamState),
      this.getRecordingState().catch(() => blankRecordingState),
      this.getReplayBufferState().catch(() => blankReplayState),
      this.obs
        .call("GetVirtualCamStatus")
        .then((result) => result.outputActive)
        .catch(() => false),
    ]);
    return {
      stream,
      recording,
      replayBuffer,
      virtualCameraActive: virtualCamera,
    };
  }

  async getProgramScreenshot(source: ObsEntityRef): Promise<string> {
    const result = await this.obs.call("GetSourceScreenshot", {
      ...entityArgs("source", source),
      imageFormat: "jpg",
      imageWidth: 1280,
      imageHeight: 720,
      imageCompressionQuality: 75,
    });
    return result.imageData;
  }

  async cleanupSession() {
    const outputs = await this.getOutputState().catch(() => null);
    if (outputs?.stream.active) {
      await this.obs.call("StopStream").catch(() => undefined);
    }
    if (outputs?.recording.active) {
      await this.obs.call("StopRecord").catch(() => undefined);
    }
    if (outputs?.replayBuffer.active) {
      await this.obs.call("StopReplayBuffer").catch(() => undefined);
    }
    if (outputs?.virtualCameraActive) {
      await this.obs.call("StopVirtualCam").catch(() => undefined);
    }
    await this.clearStreamCredentials();
    if (this.sessionProfile) {
      await this.obs
        .call("SetCurrentProfile", { profileName: "Streamz" })
        .catch(() => undefined);
      await this.obs
        .call("RemoveProfile", { profileName: this.sessionProfile })
        .catch(() => undefined);
      this.sessionProfile = null;
    }
    this.workspaceReady = false;
  }

  private async clearStreamCredentials() {
    await this.obs
      .call("SetStreamServiceSettings", {
        streamServiceType: "rtmp_custom",
        streamServiceSettings: { server: "", key: "", use_auth: false },
      })
      .catch(() => undefined);
  }
}
