export type ObsConnectionState =
  | "idle"
  | "launching"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

export type PreviewState =
  | "idle"
  | "starting"
  | "ready"
  | "permission-required"
  | "device-missing"
  | "error";

export interface ObsLaunchSession {
  websocketUrl: string;
  password: string;
  pid: number;
  version: string;
  startedAtMs: number;
  recordingPath: string;
}

export interface ObsProcessStatus {
  running: boolean;
  pid: number | null;
  version: string;
  staged: boolean;
  startedAtMs: number | null;
}

export interface SetupResult {
  started: boolean;
  requiresUserAction: boolean;
  message: string;
}

export interface ObsEntityRef {
  name: string;
  uuid?: string;
}

export interface Scene extends ObsEntityRef {
  index: number;
}

export type SourceKind =
  | "camera"
  | "microphone"
  | "display"
  | "window"
  | "browser"
  | "image"
  | "media";

export type InputPropertyValue = string | number | boolean;

export interface InputPropertyOption {
  label: string;
  value: InputPropertyValue;
  enabled: boolean;
}

export interface InputPropertyControl {
  name: string;
  label: string;
  type: "list" | "boolean" | "number" | "text" | "path";
  value: InputPropertyValue | null;
  options: InputPropertyOption[];
}

export interface InputDeviceControl {
  propertyName: string;
  currentValue: InputPropertyValue | null;
  options: InputPropertyOption[];
}

export interface InputDescriptor extends ObsEntityRef {
  inputKind: string;
  unversionedInputKind: string;
  sourceKind: SourceKind | "unknown";
  settings: Record<string, unknown>;
  properties: InputPropertyControl[];
}

export interface InputAudioState {
  muted: boolean;
  volumeDb: number;
  volumeMul: number;
  balance: number;
  syncOffsetMs: number;
  monitorType: string;
  tracks: Record<string, boolean>;
}

export interface SceneItemTransform {
  positionX: number;
  positionY: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  sourceWidth: number;
  sourceHeight: number;
  width: number;
  height: number;
  cropTop: number;
  cropBottom: number;
  cropLeft: number;
  cropRight: number;
  boundsType: string;
  boundsWidth: number;
  boundsHeight: number;
  boundsAlignment: number;
  cropToBounds: boolean;
  alignment: number;
}

export interface Source extends ObsEntityRef {
  sceneItemId: number;
  sceneItemIndex: number;
  inputKind?: string;
  sourceKind: SourceKind | "unknown";
  enabled: boolean;
  locked: boolean;
  blendMode: string;
  transform: SceneItemTransform;
  audio: InputAudioState | null;
  media: MediaState | null;
}

export interface SourceReference {
  scene: ObsEntityRef;
  sceneItemId: number;
}

export interface SourceReferenceReport {
  input: ObsEntityRef;
  references: SourceReference[];
  shared: boolean;
}

export type PlacementPreset = "fit" | "fill" | "center" | "reset";

export interface CreateInputDraft {
  kind: SourceKind;
  name: string;
  scene: ObsEntityRef;
  inputKind?: string;
  settings: Record<string, unknown>;
  placement: "fit" | "fill";
}

export interface AddSourceDraft {
  kind: SourceKind;
  name: string;
  url?: string;
  path?: string;
  settings?: Record<string, unknown>;
  placement?: "fit" | "fill";
}

export interface TransitionState {
  available: Array<ObsEntityRef & { kind?: string; configurable: boolean }>;
  current: string;
  durationMs: number;
  studioModeEnabled: boolean;
  previewScene: ObsEntityRef | null;
}

export type MediaAction =
  | "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY"
  | "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE"
  | "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP"
  | "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART"
  | "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_NEXT"
  | "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PREVIOUS";

export interface MediaState {
  state: string;
  durationMs: number;
  cursorMs: number;
}

export interface RecordingState {
  active: boolean;
  paused: boolean;
  durationMs: number;
  bytes: number;
  path: string | null;
  lastError: string | null;
}

export interface ReplayBufferState {
  active: boolean;
  lastSavedPath: string | null;
  lastError: string | null;
}

export interface OutputState {
  stream: StreamState;
  recording: RecordingState;
  replayBuffer: ReplayBufferState;
  virtualCameraActive: boolean;
}

export interface ObsCapabilityMap {
  obsVersion: string;
  websocketVersion: string;
  rpcVersion: number;
  platform: string;
  requests: string[];
  inputKinds: string[];
}

export interface StudioSnapshot {
  capabilities: ObsCapabilityMap;
  scenes: Scene[];
  currentProgramScene: ObsEntityRef | null;
  sources: Source[];
  transitions: TransitionState;
  outputs: OutputState;
}

export interface KickStreamConfig {
  server: string;
  streamKey: string;
}

export interface StreamState {
  active: boolean;
  reconnecting: boolean;
  durationMs: number;
  bytesSent: number;
  skippedFrames: number;
  totalFrames: number;
  congestion: number;
  lastError: string | null;
}

export interface AudioMeter {
  inputName: string;
  level: number;
}

export interface ActionStatus {
  pending: boolean;
  error: string | null;
}
