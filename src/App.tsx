import { isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useObsStudio } from "./hooks/useObsStudio";
import type {
  AddSourceDraft,
  InputPropertyControl,
  InputPropertyValue,
  KickStreamConfig,
  Scene,
  SceneItemTransform,
  Source,
  SourceKind,
} from "./types/obs";
import "./App.css";

const KICK_SERVER =
  "rtmps://fa723fc1b171.global-contribute.live-video.net:443/app";

const sourceOptions: Array<{
  kind: SourceKind;
  label: string;
  icon: string;
  description: string;
}> = [
  { kind: "camera", label: "Camera", icon: "◉", description: "Video device" },
  {
    kind: "microphone",
    label: "Microphone",
    icon: "♩",
    description: "Audio input",
  },
  { kind: "display", label: "Display", icon: "▣", description: "Entire screen" },
  { kind: "window", label: "Window", icon: "▤", description: "Application" },
  { kind: "browser", label: "Browser", icon: "◎", description: "Web overlay" },
  { kind: "image", label: "Image", icon: "◇", description: "Image file" },
  { kind: "media", label: "Media", icon: "▶", description: "Video or audio" },
];

function formatDuration(milliseconds: number) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds]
    .map((value) => value.toString().padStart(2, "0"))
    .join(":");
}

function StudioIcon({
  name,
}: {
  name: "obs" | "record" | "pause" | "play" | "stop";
}) {
  if (name === "obs") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle className="obs-ring" cx="12" cy="12" r="9" />
        <circle cx="12" cy="8" r="3" />
        <circle cx="8.5" cy="14.2" r="3" />
        <circle cx="15.5" cy="14.2" r="3" />
      </svg>
    );
  }
  if (name === "record") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="6" />
      </svg>
    );
  }
  if (name === "pause") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M8 6v12M16 6v12" />
      </svg>
    );
  }
  if (name === "play") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m9 6 9 6-9 6Z" />
      </svg>
    );
  }
  if (name === "stop") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="7" y="7" width="10" height="10" rx="1" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m9 6 9 6-9 6Z" />
    </svg>
  );
}

function HeaderIconButton({
  label,
  className = "",
  disabled = false,
  pressed,
  onClick,
  children,
}: {
  label: string;
  className?: string;
  disabled?: boolean;
  pressed?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`header-icon-button ${className}`}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function VideoPreview({
  stream,
  image,
  sources,
  selectedSourceId,
  onSelect,
  onTransform,
}: {
  stream: MediaStream | null;
  image: string | null;
  sources: Source[];
  selectedSourceId: number | null;
  onSelect: (id: number) => void;
  onTransform: (
    id: number,
    transform: Partial<SceneItemTransform>,
  ) => Promise<void>;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [gesture, setGesture] = useState<{
    id: number;
    mode: "move" | "resize";
    startX: number;
    startY: number;
    transform: SceneItemTransform;
  } | null>(null);
  const [delta, setDelta] = useState({ x: 0, y: 0 });

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream;
  }, [stream]);

  const selected = sources.find(
    (source) => source.sceneItemId === selectedSourceId,
  );

  const startGesture = (
    event: ReactPointerEvent,
    source: Source,
    mode: "move" | "resize",
  ) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    onSelect(source.sceneItemId);
    setDelta({ x: 0, y: 0 });
    setGesture({
      id: source.sceneItemId,
      mode,
      startX: event.clientX,
      startY: event.clientY,
      transform: source.transform,
    });
  };

  const updateGesture = (event: ReactPointerEvent) => {
    if (!gesture) return;
    setDelta({
      x: event.clientX - gesture.startX,
      y: event.clientY - gesture.startY,
    });
  };

  const finishGesture = async () => {
    if (!gesture || !canvasRef.current) return;
    const bounds = canvasRef.current.getBoundingClientRect();
    const canvasDx = (delta.x / bounds.width) * 1920;
    const canvasDy = (delta.y / bounds.height) * 1080;
    if (gesture.mode === "move") {
      await onTransform(gesture.id, {
        positionX: gesture.transform.positionX + canvasDx,
        positionY: gesture.transform.positionY + canvasDy,
      });
    } else {
      const width = Math.max(1, gesture.transform.sourceWidth || 1920);
      const nextScale = Math.max(
        0.05,
        gesture.transform.scaleX + canvasDx / width,
      );
      await onTransform(gesture.id, {
        scaleX: nextScale,
        scaleY: nextScale,
      });
    }
    setGesture(null);
    setDelta({ x: 0, y: 0 });
  };

  const overlayStyle = selected
    ? (() => {
        const transform = selected.transform;
        const croppedWidth = Math.max(
          1,
          transform.sourceWidth - transform.cropLeft - transform.cropRight,
        );
        const croppedHeight = Math.max(
          1,
          transform.sourceHeight - transform.cropTop - transform.cropBottom,
        );
        const displayWidth =
          transform.width || croppedWidth * Math.abs(transform.scaleX);
        const displayHeight =
          transform.height || croppedHeight * Math.abs(transform.scaleY);
        const alignX =
          transform.alignment & 1
            ? 0
            : transform.alignment & 2
              ? -100
              : -50;
        const alignY =
          transform.alignment & 4
            ? 0
            : transform.alignment & 8
              ? -100
              : -50;
        return {
        left: `${(selected.transform.positionX / 1920) * 100}%`,
        top: `${(selected.transform.positionY / 1080) * 100}%`,
          width: `${(displayWidth / 1920) * 100}%`,
          height: `${(displayHeight / 1080) * 100}%`,
          transform: `translate(${alignX}%, ${alignY}%) translate(${delta.x}px, ${delta.y}px) rotate(${transform.rotation}deg)`,
        };
      })()
    : undefined;

  return (
    <div className="preview-shell">
      <div className="preview-canvas" ref={canvasRef}>
        {stream ? (
          <video ref={videoRef} autoPlay muted playsInline />
        ) : image ? (
          <img src={image} alt="OBS program preview" />
        ) : (
          <div className="preview-empty">
            <div className="preview-orbit">
              <span>▶</span>
            </div>
            <strong>Program preview</strong>
            <p>Launch OBS and start Preview to see your live canvas.</p>
          </div>
        )}
        {(stream || image) && selected && selected.enabled ? (
          <div
            className="source-transform"
            style={overlayStyle}
            onPointerDown={(event) => startGesture(event, selected, "move")}
            onPointerMove={updateGesture}
            onPointerUp={() => void finishGesture()}
          >
            <span className="source-label">{selected.name}</span>
            <button
              className="resize-handle"
              aria-label="Resize source"
              onPointerDown={(event) =>
                startGesture(event, selected, "resize")
              }
              onPointerMove={updateGesture}
              onPointerUp={() => void finishGesture()}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function SceneModal({
  existingNames,
  onClose,
  onCreate,
}: {
  existingNames: string[];
  onClose: () => void;
  onCreate: (name: string) => Promise<unknown>;
}) {
  const [name, setName] = useState(`Scene ${existingNames.length + 1}`);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const normalizedNames = useMemo(
    () => new Set(existingNames.map((item) => item.trim().toLocaleLowerCase())),
    [existingNames],
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setSubmitError("Enter a scene name.");
      return;
    }
    if (normalizedNames.has(trimmed.toLocaleLowerCase())) {
      setSubmitError("A scene with this name already exists.");
      return;
    }
    setBusy(true);
    setSubmitError(null);
    try {
      await onCreate(trimmed);
      onClose();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="modal-card scene-modal"
        onSubmit={submit}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">Workspace</span>
            <h2>Add scene</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close add scene dialog"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <label>
          Scene name
          <input
            value={name}
            onChange={(event) => {
              setName(event.currentTarget.value);
              setSubmitError(null);
            }}
            autoFocus
            aria-describedby={submitError ? "scene-name-error" : undefined}
          />
        </label>
        {submitError ? (
          <p id="scene-name-error" className="modal-error" role="alert">
            {submitError}
          </p>
        ) : null}
        <div className="modal-actions">
          <button type="button" className="button ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={busy || !name.trim()}>
            {busy ? "Adding…" : "Add scene"}
          </button>
        </div>
      </form>
    </div>
  );
}

export function SourceModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (draft: AddSourceDraft) => Promise<void>;
}) {
  const [kind, setKind] = useState<SourceKind>("camera");
  const [name, setName] = useState("Camera");
  const [detail, setDetail] = useState("");
  const [placement, setPlacement] = useState<"fit" | "fill">("fit");
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const selected = sourceOptions.find((option) => option.kind === kind)!;

  const selectKind = (nextKind: SourceKind, label: string) => {
    setKind(nextKind);
    setName(label);
    setDetail("");
    setSubmitError(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setSubmitError(null);
    try {
      await onCreate({
        kind,
        name: name.trim(),
        url: kind === "browser" ? detail.trim() : undefined,
        path:
          kind === "image" || kind === "media" ? detail.trim() : undefined,
        placement,
      });
      onClose();
    } catch (error) {
      setSubmitError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="modal-card source-modal"
        onSubmit={submit}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">Add to scene</span>
            <h2>New source</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="source-kind-grid">
          {sourceOptions.map((option) => (
            <button
              key={option.kind}
              type="button"
              className={kind === option.kind ? "is-selected" : ""}
              onClick={() => selectKind(option.kind, option.label)}
            >
              <span>{option.icon}</span>
              <strong>{option.label}</strong>
              <small>{option.description}</small>
            </button>
          ))}
        </div>
        <label>
          Source name
          <input
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            required
            autoFocus
          />
        </label>
        {kind === "browser" ? (
          <label>
            URL
            <input
              type="url"
              value={detail}
              onChange={(event) => setDetail(event.currentTarget.value)}
              placeholder="https://..."
              required
            />
          </label>
        ) : null}
        {kind === "image" || kind === "media" ? (
          <label>
            {kind === "image" ? "Image file" : "Media file"}
            <div className="path-field">
              <input
                value={detail}
                onChange={(event) => setDetail(event.currentTarget.value)}
                placeholder="Choose a local file"
                required
              />
              <button
                type="button"
                onClick={() => {
                  void open({
                    multiple: false,
                    directory: false,
                    filters:
                      kind === "image"
                        ? [
                            {
                              name: "Images",
                              extensions: [
                                "png",
                                "jpg",
                                "jpeg",
                                "gif",
                                "webp",
                                "bmp",
                              ],
                            },
                          ]
                        : [
                            {
                              name: "Media",
                              extensions: [
                                "mp4",
                                "mov",
                                "mkv",
                                "webm",
                                "mp3",
                                "wav",
                                "m4a",
                              ],
                            },
                          ],
                  }).then((path) => {
                    if (typeof path === "string") setDetail(path);
                  });
                }}
              >
                Browse
              </button>
            </div>
          </label>
        ) : null}
        {kind !== "microphone" ? (
          <label>
            Initial placement
            <select
              value={placement}
              onChange={(event) =>
                setPlacement(event.currentTarget.value as "fit" | "fill")
              }
            >
              <option value="fit">Fit and center</option>
              <option value="fill">Fill canvas</option>
            </select>
          </label>
        ) : null}
        {["camera", "microphone", "display", "window"].includes(kind) ? (
          <p className="modal-note">
            {selected.label} starts with the first available target. Select the
            source afterward to change its device or capture options.
          </p>
        ) : null}
        {submitError ? (
          <p className="modal-error" role="alert">
            {submitError}
          </p>
        ) : null}
        <div className="modal-actions">
          <button type="button" className="button ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button primary"
            disabled={busy || !name.trim()}
          >
            {busy ? "Adding…" : "Add source"}
          </button>
        </div>
      </form>
    </div>
  );
}

function InputPropertiesEditor({
  source,
  load,
  update,
}: {
  source: Source;
  load: (source: Source) => Promise<InputPropertyControl[]>;
  update: (
    source: Source,
    propertyName: string,
    value: InputPropertyValue,
  ) => Promise<void>;
}) {
  const [controls, setControls] = useState<InputPropertyControl[]>([]);
  const [loading, setLoading] = useState(true);
  const [propertyError, setPropertyError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setPropertyError(null);
    void load(source)
      .then((next) => {
        if (!cancelled) setControls(next);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setPropertyError(
            error instanceof Error ? error.message : String(error),
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [load, source]);

  const commit = async (
    control: InputPropertyControl,
    value: InputPropertyValue,
  ) => {
    setPropertyError(null);
    setControls((current) =>
      current.map((item) =>
        item.name === control.name ? { ...item, value } : item,
      ),
    );
    try {
      await update(source, control.name, value);
    } catch (error) {
      setPropertyError(error instanceof Error ? error.message : String(error));
    }
  };

  if (loading) {
    return <small className="helper-copy">Loading OBS properties…</small>;
  }
  if (!controls.length && !propertyError) return null;

  return (
    <div className="property-group">
      <span className="property-title">Source properties</span>
      <div className="property-stack">
        {controls.map((control) => {
          if (control.type === "list") {
            return (
              <label key={control.name}>
                {control.label}
                <select
                  value={control.value === null ? "" : String(control.value)}
                  onChange={(event) => {
                    const option = control.options.find(
                      (item) =>
                        String(item.value) === event.currentTarget.value,
                    );
                    if (option) void commit(control, option.value);
                  }}
                >
                  {control.value === null ? (
                    <option value="" disabled>
                      Choose…
                    </option>
                  ) : null}
                  {control.options.map((option) => (
                    <option
                      key={`${option.label}-${String(option.value)}`}
                      value={String(option.value)}
                      disabled={!option.enabled}
                    >
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            );
          }
          if (control.type === "boolean") {
            return (
              <label className="checkbox-field" key={control.name}>
                <input
                  type="checkbox"
                  checked={Boolean(control.value)}
                  onChange={(event) =>
                    void commit(control, event.currentTarget.checked)
                  }
                />
                {control.label}
              </label>
            );
          }
          if (control.type === "path") {
            return (
              <label key={control.name}>
                {control.label}
                <div className="path-field">
                  <input
                    value={String(control.value ?? "")}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setControls((current) =>
                        current.map((item) =>
                          item.name === control.name
                            ? { ...item, value }
                            : item,
                        ),
                      );
                    }}
                    onBlur={(event) =>
                      void commit(control, event.currentTarget.value)
                    }
                  />
                  <button
                    type="button"
                    onClick={() => {
                      void open({ multiple: false, directory: false }).then(
                        (path) => {
                          if (typeof path === "string") {
                            void commit(control, path);
                          }
                        },
                      );
                    }}
                  >
                    Browse
                  </button>
                </div>
              </label>
            );
          }
          return (
            <label key={control.name}>
              {control.label}
              <input
                type={control.type === "number" ? "number" : "text"}
                value={String(control.value ?? "")}
                onChange={(event) => {
                  const value =
                    control.type === "number"
                      ? Number(event.currentTarget.value)
                      : event.currentTarget.value;
                  setControls((current) =>
                    current.map((item) =>
                      item.name === control.name ? { ...item, value } : item,
                    ),
                  );
                }}
                onBlur={(event) =>
                  void commit(
                    control,
                    control.type === "number"
                      ? Number(event.currentTarget.value)
                      : event.currentTarget.value,
                  )
                }
              />
            </label>
          );
        })}
      </div>
      {propertyError ? (
        <p className="property-error" role="alert">
          {propertyError}
        </p>
      ) : null}
    </div>
  );
}

function App() {
  const studio = useObsStudio();
  const [sceneModalOpen, setSceneModalOpen] = useState(false);
  const [sourceModalOpen, setSourceModalOpen] = useState(false);
  const [streamModalOpen, setStreamModalOpen] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [kickConfig, setKickConfig] = useState<KickStreamConfig>({
    server: KICK_SERVER,
    streamKey: "",
  });
  const destroyingRef = useRef(false);
  const connected = studio.connection === "connected";
  const selectedSource = studio.sources.find(
    (source) => source.sceneItemId === studio.selectedSourceId,
  );

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        if (destroyingRef.current) return;
        event.preventDefault();
        if (
          studio.streamState.active &&
          !window.confirm(
            "You are live on Kick. End the stream and close Streamz?",
          )
        ) {
          return;
        }
        destroyingRef.current = true;
        if (studio.streamState.active) await studio.stopStream();
        await Promise.race([
          studio.shutdown().catch(() => undefined),
          new Promise<void>((resolve) =>
            window.setTimeout(resolve, 3_000),
          ),
        ]);
        await getCurrentWindow().destroy();
      })
      .then((dispose) => {
        unlisten = dispose;
      });
    return () => unlisten?.();
  }, [studio.shutdown, studio.stopStream, studio.streamState.active]);

  const runAction = async (action: () => Promise<unknown>) => {
    try {
      await action();
    } catch {
      // The studio hook exposes the sanitized error in the workspace.
    }
  };

  const renameScene = (scene: Scene) => {
    const nextName = window.prompt("Rename scene", scene.name);
    if (nextName?.trim() && nextName.trim() !== scene.name) {
      void runAction(() => studio.renameScene(scene, nextName.trim()));
    }
  };

  const removeScene = (scene: Scene) => {
    if (
      studio.scenes.length > 1 &&
      window.confirm(`Delete the “${scene.name}” scene?`)
    ) {
      void runAction(() => studio.removeScene(scene));
    }
  };

  const removeSelectedSource = async () => {
    if (!selectedSource) return;
    const report = await studio.getSourceReferences(selectedSource);
    if (!report.shared) {
      if (
        window.confirm(
          `Delete “${selectedSource.name}” from OBS? This cannot be undone.`,
        )
      ) {
        await studio.removeSource(selectedSource, "everywhere");
      }
      return;
    }

    const decision = window
      .prompt(
        `“${selectedSource.name}” is used in ${report.references.length} scene items.\n\nType “scene” to remove it only here, or “everywhere” to delete the OBS input and all references.`,
        "scene",
      )
      ?.trim()
      .toLowerCase();
    if (decision === "scene") {
      await studio.removeSource(selectedSource, "scene");
    } else if (
      decision === "everywhere" &&
      window.confirm(
        `Delete “${selectedSource.name}” from every scene? This cannot be undone.`,
      )
    ) {
      await studio.removeSource(selectedSource, "everywhere");
    }
  };

  const goLive = async () => {
    await studio.startStream(kickConfig);
    setStreamModalOpen(false);
    setKickConfig((config) => ({ ...config, streamKey: "" }));
  };

  const obsStatus =
    studio.connection === "connected"
      ? "connected"
      : studio.connection === "launching" ||
          studio.connection === "connecting" ||
          studio.connection === "reconnecting"
        ? "connecting"
        : "offline";
  const outputPath = studio.recordingState.path;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <div className="brand-mark">
            <span />
          </div>
          <div>
            <strong>streamz</strong>
            <small>Creator Studio</small>
          </div>
        </div>
        <div className="header-actions">
          <div className="header-output-group">
            <HeaderIconButton
              label={
                connected
                  ? `Open OBS${studio.preview === "ready" ? ", preview ready" : ""}`
                  : obsStatus === "connecting"
                    ? "OBS is starting"
                    : "Start OBS"
              }
              className={`obs-control is-${obsStatus}`}
              disabled={obsStatus === "connecting"}
              onClick={() =>
                void (connected
                  ? runAction(studio.revealObs)
                  : studio.launch())
              }
            >
              <StudioIcon name="obs" />
              <span className="control-status-dot" />
            </HeaderIconButton>
            <span className="header-divider" />
            <div
              className={`recording-controls ${
                studio.recordingState.active ? "is-active" : ""
              } ${studio.recordingState.paused ? "is-paused" : ""}`}
            >
              {studio.recordingState.active ? (
                <span className="recording-state" role="status">
                  <span />
                  {studio.recordingState.paused
                    ? "Paused"
                    : formatDuration(studio.recordingState.durationMs)}
                </span>
              ) : null}
              {studio.recordingState.active ? (
                <>
                  <HeaderIconButton
                    label={
                      studio.recordingState.paused
                        ? "Resume recording"
                        : "Pause recording"
                    }
                    className="record-action"
                    disabled={studio.isPending("output:record-pause")}
                    pressed={studio.recordingState.paused}
                    onClick={() =>
                      void runAction(() =>
                        studio.setRecordingPaused(
                          !studio.recordingState.paused,
                        ),
                      )
                    }
                  >
                    <StudioIcon
                      name={studio.recordingState.paused ? "play" : "pause"}
                    />
                    <span>
                      {studio.recordingState.paused ? "Resume" : "Pause"}
                    </span>
                  </HeaderIconButton>
                  <HeaderIconButton
                    label="Stop recording"
                    className="record-action stop-recording"
                    disabled={studio.isPending("output:record")}
                    onClick={() => void runAction(studio.stopRecording)}
                  >
                    <StudioIcon name="stop" />
                    <span>Stop</span>
                  </HeaderIconButton>
                </>
              ) : (
                <HeaderIconButton
                  label="Start recording"
                  className="record-action"
                  disabled={
                    !connected || studio.isPending("output:record")
                  }
                  onClick={() => void runAction(studio.startRecording)}
                >
                  <StudioIcon name="record" />
                  <span>Record</span>
                </HeaderIconButton>
              )}
            </div>
          </div>
          <button
            type="button"
            className={`kick-live-control ${
              studio.streamState.active ? "is-live" : ""
            }`}
            disabled={
              !connected || studio.isPending("output:stream")
            }
            onClick={() => {
              if (!studio.streamState.active) {
                setStreamModalOpen(true);
                return;
              }
              if (window.confirm("End the live stream on Kick?")) {
                void runAction(studio.stopStream);
              }
            }}
          >
            <span className="live-dot" />
            {studio.streamState.active
              ? `LIVE · ${formatDuration(studio.streamState.durationMs)}`
              : "Go live"}
          </button>
        </div>
      </header>
      {outputPath ? (
        <div className="output-feedback" role="status" title={outputPath}>
          Saved locally: {outputPath}
        </div>
      ) : null}

      <main className="studio-grid">
        <aside className="panel scenes-panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">Workspace</span>
              <h2>Scenes</h2>
            </div>
            <button
              className="icon-button"
              aria-label="Create scene"
              disabled={!connected || studio.isPending("scene:create")}
              onClick={() => setSceneModalOpen(true)}
            >
              +
            </button>
          </div>
          <div className="scene-list">
            {studio.scenes.map((scene, index) => (
              <button
                key={scene.uuid ?? scene.name}
                className={`scene-card ${
                  scene.name === studio.currentScene ? "is-active" : ""
                }`}
                onClick={() =>
                  void runAction(() =>
                    studio.selectScene(
                      scene,
                      studio.transitions.studioModeEnabled
                        ? "preview"
                        : "program",
                    ),
                  )
                }
              >
                <span className="scene-index">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="scene-copy">
                  <strong>{scene.name}</strong>
                  <small>
                    {scene.uuid === studio.programScene?.uuid ||
                    scene.name === studio.programScene?.name
                      ? "Program"
                      : scene.uuid === studio.transitions.previewScene?.uuid ||
                          scene.name === studio.transitions.previewScene?.name
                        ? "Preview"
                        : "Scene"}
                  </small>
                </span>
                <span className="scene-menu">
                  <span
                    role="button"
                    tabIndex={0}
                    title="Rename"
                    onClick={(event) => {
                      event.stopPropagation();
                      renameScene(scene);
                    }}
                  >
                    ✎
                  </span>
                  <span
                    role="button"
                    tabIndex={0}
                    title="Delete"
                    onClick={(event) => {
                      event.stopPropagation();
                      removeScene(scene);
                    }}
                  >
                    ×
                  </span>
                </span>
              </button>
            ))}
            {!studio.scenes.length ? (
              <div className="empty-list">
                <span>◫</span>
                <p>Scenes appear after OBS connects.</p>
              </div>
            ) : null}
          </div>
        </aside>

        <section className="canvas-column">
          {studio.error ? (
            <div className="alert error-alert">
              <span>!</span>
              <p>{studio.error}</p>
              <button
                onClick={() => {
                  if (connected) {
                    studio.clearError();
                  } else if (studio.connection === "reconnecting") {
                    void studio.reconnect();
                  } else {
                    void studio.launch();
                  }
                }}
              >
                {connected ? "Dismiss" : "Reconnect"}
              </button>
            </div>
          ) : null}
          {studio.setupMessage ? (
            <div className="alert setup-alert">
              <span>i</span>
              <p>{studio.setupMessage}</p>
              <button
                onClick={() =>
                  void runAction(studio.installVirtualCamera)
                }
              >
                Run setup
              </button>
            </div>
          ) : null}
          <VideoPreview
            stream={studio.previewStream}
            image={studio.previewImage}
            sources={studio.sources}
            selectedSourceId={studio.selectedSourceId}
            onSelect={studio.setSelectedSourceId}
            onTransform={studio.setSourceTransform}
          />
          <div className="program-bar">
            <div>
              <span className="program-label">PROGRAM</span>
              <strong>
                {studio.programScene?.name || "No active scene"}
              </strong>
            </div>
            <div className="program-meta">
              <span>1920 × 1080</span>
              <span>30 FPS</span>
              <span>H.264</span>
            </div>
          </div>
          <div className="sources-panel panel">
            <div className="panel-heading compact">
              <div>
                <span className="eyebrow">Composition</span>
                <h2>Sources</h2>
              </div>
              <button
                className="button secondary"
                disabled={!connected || !studio.currentScene}
                onClick={() => setSourceModalOpen(true)}
              >
                + Add source
              </button>
            </div>
            <div className="source-list">
              {studio.sources.map((source) => (
                <button
                  key={source.sceneItemId}
                  className={`source-row ${
                    source.sceneItemId === studio.selectedSourceId
                      ? "is-selected"
                      : ""
                  }`}
                  onClick={() =>
                    studio.setSelectedSourceId(source.sceneItemId)
                  }
                >
                  <span
                    className={`source-visibility ${
                      source.enabled ? "is-visible" : ""
                    }`}
                    title={source.enabled ? "Hide source" : "Show source"}
                    onClick={(event) => {
                      event.stopPropagation();
                      void runAction(() =>
                        studio.setSourceEnabled(
                          source,
                          !source.enabled,
                        ),
                      );
                    }}
                  >
                    {source.enabled ? "◉" : "○"}
                  </span>
                  <span className="source-type">▦</span>
                  <span className="source-name">
                    <strong>{source.name}</strong>
                    <small>{source.inputKind ?? "scene source"}</small>
                  </span>
                  <span
                    className="meter-mini"
                    style={
                      {
                        "--meter": `${(studio.meters[source.name] ?? 0) * 100}%`,
                      } as React.CSSProperties
                    }
                  />
                  <span className="source-actions">
                    <span
                      title="Move up"
                      onClick={(event) => {
                        event.stopPropagation();
                        void runAction(() => studio.moveSource(source, "up"));
                      }}
                    >
                      ↑
                    </span>
                    <span
                      title="Move down"
                      onClick={(event) => {
                        event.stopPropagation();
                        void runAction(() =>
                          studio.moveSource(source, "down"),
                        );
                      }}
                    >
                      ↓
                    </span>
                  </span>
                </button>
              ))}
              {!studio.sources.length ? (
                <div className="empty-list horizontal">
                  <span>＋</span>
                  <p>Add a camera, display, browser, image, or media source.</p>
                </div>
              ) : null}
            </div>
          </div>
        </section>

        <aside className="right-column">
          <section className="panel inspector-panel">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">Selected</span>
                <h2>Properties</h2>
              </div>
            </div>
            {selectedSource ? (
              <div className="inspector-content">
                <div className="selected-source-title">
                  <span>▦</span>
                  <div>
                    <strong>{selectedSource.name}</strong>
                    <small>{selectedSource.inputKind ?? "Source"}</small>
                  </div>
                </div>
                <div className="inspector-actions">
                  <button
                    onClick={() => {
                      const name = window.prompt(
                        "Rename source",
                        selectedSource.name,
                      );
                      if (name?.trim()) {
                        void runAction(() =>
                          studio.renameSource(
                            selectedSource,
                            name.trim(),
                          ),
                        );
                      }
                    }}
                  >
                    Rename
                  </button>
                  <button
                    onClick={() =>
                      void runAction(() =>
                        studio.duplicateSource(selectedSource, "independent"),
                      )
                    }
                  >
                    Copy
                  </button>
                  <button
                    onClick={() =>
                      void runAction(() =>
                        studio.duplicateSource(selectedSource, "reference"),
                      )
                    }
                  >
                    Reference
                  </button>
                  <button
                    className="danger"
                    onClick={() => void runAction(removeSelectedSource)}
                  >
                    Remove
                  </button>
                </div>
                <InputPropertiesEditor
                  source={selectedSource}
                  load={studio.getInputProperties}
                  update={studio.setInputProperty}
                />
                <div className="property-group">
                  <span className="property-title">Transform</span>
                  <div className="field-grid">
                    <label>
                      X
                      <input
                        type="number"
                        value={Math.round(
                          selectedSource.transform.positionX,
                        )}
                        onChange={(event) =>
                          void studio.setSourceTransform(
                            selectedSource.sceneItemId,
                            { positionX: Number(event.currentTarget.value) },
                          )
                        }
                      />
                    </label>
                    <label>
                      Y
                      <input
                        type="number"
                        value={Math.round(
                          selectedSource.transform.positionY,
                        )}
                        onChange={(event) =>
                          void studio.setSourceTransform(
                            selectedSource.sceneItemId,
                            { positionY: Number(event.currentTarget.value) },
                          )
                        }
                      />
                    </label>
                    <label>
                      Scale X
                      <input
                        type="number"
                        step="0.05"
                        value={selectedSource.transform.scaleX.toFixed(2)}
                        onChange={(event) =>
                          void studio.setSourceTransform(
                            selectedSource.sceneItemId,
                            { scaleX: Number(event.currentTarget.value) },
                          )
                        }
                      />
                    </label>
                    <label>
                      Scale Y
                      <input
                        type="number"
                        step="0.05"
                        value={selectedSource.transform.scaleY.toFixed(2)}
                        onChange={(event) =>
                          void studio.setSourceTransform(
                            selectedSource.sceneItemId,
                            { scaleY: Number(event.currentTarget.value) },
                          )
                        }
                      />
                    </label>
                    <label>
                      Rotation
                      <input
                        type="number"
                        step="1"
                        value={selectedSource.transform.rotation.toFixed(1)}
                        onChange={(event) =>
                          void studio.setSourceTransform(
                            selectedSource.sceneItemId,
                            { rotation: Number(event.currentTarget.value) },
                          )
                        }
                      />
                    </label>
                    <label>
                      Alignment
                      <select
                        value={selectedSource.transform.alignment}
                        onChange={(event) =>
                          void studio.setSourceTransform(
                            selectedSource.sceneItemId,
                            { alignment: Number(event.currentTarget.value) },
                          )
                        }
                      >
                        <option value={5}>Top left</option>
                        <option value={4}>Top center</option>
                        <option value={6}>Top right</option>
                        <option value={1}>Center left</option>
                        <option value={0}>Center</option>
                        <option value={2}>Center right</option>
                        <option value={9}>Bottom left</option>
                        <option value={8}>Bottom center</option>
                        <option value={10}>Bottom right</option>
                      </select>
                    </label>
                    <label>
                      Crop left
                      <input
                        type="number"
                        min="0"
                        value={selectedSource.transform.cropLeft}
                        onChange={(event) =>
                          void studio.setSourceTransform(
                            selectedSource.sceneItemId,
                            { cropLeft: Number(event.currentTarget.value) },
                          )
                        }
                      />
                    </label>
                    <label>
                      Crop right
                      <input
                        type="number"
                        min="0"
                        value={selectedSource.transform.cropRight}
                        onChange={(event) =>
                          void studio.setSourceTransform(
                            selectedSource.sceneItemId,
                            { cropRight: Number(event.currentTarget.value) },
                          )
                        }
                      />
                    </label>
                    <label>
                      Crop top
                      <input
                        type="number"
                        min="0"
                        value={selectedSource.transform.cropTop}
                        onChange={(event) =>
                          void studio.setSourceTransform(
                            selectedSource.sceneItemId,
                            { cropTop: Number(event.currentTarget.value) },
                          )
                        }
                      />
                    </label>
                    <label>
                      Crop bottom
                      <input
                        type="number"
                        min="0"
                        value={selectedSource.transform.cropBottom}
                        onChange={(event) =>
                          void studio.setSourceTransform(
                            selectedSource.sceneItemId,
                            { cropBottom: Number(event.currentTarget.value) },
                          )
                        }
                      />
                    </label>
                  </div>
                  <div className="transform-presets">
                    <button
                      onClick={() =>
                        void studio.applyPlacement(selectedSource, "fit")
                      }
                    >
                      Fit
                    </button>
                    <button
                      onClick={() =>
                        void studio.applyPlacement(selectedSource, "fill")
                      }
                    >
                      Fill
                    </button>
                    <button
                      onClick={() =>
                        void studio.applyPlacement(selectedSource, "center")
                      }
                    >
                      Center
                    </button>
                    <button
                      onClick={() =>
                        void studio.applyPlacement(selectedSource, "reset")
                      }
                    >
                      Reset
                    </button>
                  </div>
                  <div className="property-stack compact-stack">
                    <label className="checkbox-field">
                      <input
                        type="checkbox"
                        checked={selectedSource.locked}
                        onChange={(event) =>
                          void studio.setSourceLocked(
                            selectedSource,
                            event.currentTarget.checked,
                          )
                        }
                      />
                      Lock scene item
                    </label>
                    <label>
                      Blend mode
                      <select
                        value={selectedSource.blendMode}
                        onChange={(event) =>
                          void studio.setSourceBlendMode(
                            selectedSource,
                            event.currentTarget.value,
                          )
                        }
                      >
                        <option value="OBS_BLEND_NORMAL">Normal</option>
                        <option value="OBS_BLEND_ADDITIVE">Additive</option>
                        <option value="OBS_BLEND_SUBTRACT">Subtract</option>
                        <option value="OBS_BLEND_SCREEN">Screen</option>
                        <option value="OBS_BLEND_MULTIPLY">Multiply</option>
                        <option value="OBS_BLEND_LIGHTEN">Lighten</option>
                        <option value="OBS_BLEND_DARKEN">Darken</option>
                      </select>
                    </label>
                  </div>
                </div>
                {selectedSource.audio ? (
                  <div className="property-group">
                    <span className="property-title">Audio</span>
                    <div className="audio-strip">
                      <button
                        className={`mute-button ${
                          selectedSource.audio.muted ? "is-muted" : ""
                        }`}
                        onClick={() =>
                          void studio.setInputMute(
                            selectedSource,
                            !selectedSource.audio!.muted,
                          )
                        }
                      >
                        {selectedSource.audio.muted ? "Unmute" : "Mute"}
                      </button>
                      <div className="meter-track">
                        <span
                          style={{
                            width: `${(studio.meters[selectedSource.name] ?? 0) * 100}%`,
                          }}
                        />
                      </div>
                    </div>
                    <label>
                      Volume ({selectedSource.audio.volumeDb.toFixed(1)} dB)
                      <input
                        type="range"
                        min="-100"
                        max="26"
                        step="0.5"
                        value={selectedSource.audio.volumeDb}
                        onChange={(event) =>
                          void studio.setInputVolume(
                            selectedSource,
                            Number(event.currentTarget.value),
                          )
                        }
                      />
                    </label>
                    <div className="field-grid">
                      <label>
                        Balance
                        <input
                          type="number"
                          min="0"
                          max="1"
                          step="0.05"
                          value={selectedSource.audio.balance}
                          onChange={(event) =>
                            void studio.setInputAudioBalance(
                              selectedSource,
                              Number(event.currentTarget.value),
                            )
                          }
                        />
                      </label>
                      <label>
                        Sync offset (ms)
                        <input
                          type="number"
                          min="-950"
                          max="20000"
                          value={selectedSource.audio.syncOffsetMs}
                          onChange={(event) =>
                            void studio.setInputAudioSyncOffset(
                              selectedSource,
                              Number(event.currentTarget.value),
                            )
                          }
                        />
                      </label>
                    </div>
                    <label>
                      Audio monitoring
                      <select
                        value={selectedSource.audio.monitorType}
                        onChange={(event) =>
                          void studio.setInputAudioMonitorType(
                            selectedSource,
                            event.currentTarget.value,
                          )
                        }
                      >
                        <option value="OBS_MONITORING_TYPE_NONE">
                          Monitor off
                        </option>
                        <option value="OBS_MONITORING_TYPE_MONITOR_ONLY">
                          Monitor only
                        </option>
                        <option value="OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT">
                          Monitor and output
                        </option>
                      </select>
                    </label>
                    <small className="helper-copy">
                      Streamz displays levels without playing monitored audio.
                    </small>
                  </div>
                ) : null}
                {selectedSource.media ? (
                  <div className="property-group">
                    <span className="property-title">Media</span>
                    <div className="media-controls">
                      <button
                        onClick={() =>
                          void studio.triggerMediaAction(
                            selectedSource,
                            "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PREVIOUS",
                          )
                        }
                      >
                        Previous
                      </button>
                      <button
                        onClick={() =>
                          void studio.triggerMediaAction(
                            selectedSource,
                            selectedSource.media?.state ===
                              "OBS_MEDIA_STATE_PLAYING"
                              ? "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE"
                              : "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY",
                          )
                        }
                      >
                        {selectedSource.media.state === "OBS_MEDIA_STATE_PLAYING"
                          ? "Pause"
                          : "Play"}
                      </button>
                      <button
                        onClick={() =>
                          void studio.triggerMediaAction(
                            selectedSource,
                            "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART",
                          )
                        }
                      >
                        Restart
                      </button>
                      <button
                        onClick={() =>
                          void studio.triggerMediaAction(
                            selectedSource,
                            "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP",
                          )
                        }
                      >
                        Stop
                      </button>
                      <button
                        onClick={() =>
                          void studio.triggerMediaAction(
                            selectedSource,
                            "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_NEXT",
                          )
                        }
                      >
                        Next
                      </button>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max={Math.max(1, selectedSource.media.durationMs)}
                      value={selectedSource.media.cursorMs}
                      onChange={(event) =>
                        void studio.setMediaCursor(
                          selectedSource,
                          Number(event.currentTarget.value),
                        )
                      }
                    />
                    <small className="helper-copy">
                      {formatDuration(selectedSource.media.cursorMs)} /{" "}
                      {formatDuration(selectedSource.media.durationMs)}
                    </small>
                  </div>
                ) : null}
                <div className="advanced-actions">
                  <button
                    className="advanced-link"
                    onClick={() =>
                      void studio.openInputDialog(
                        selectedSource,
                        "properties",
                      )
                    }
                  >
                    OBS properties ↗
                  </button>
                  <button
                    className="advanced-link"
                    onClick={() =>
                      void studio.openInputDialog(selectedSource, "filters")
                    }
                  >
                    OBS filters ↗
                  </button>
                  {selectedSource.sourceKind === "browser" ? (
                    <button
                      className="advanced-link"
                      onClick={() =>
                        void studio.openInputDialog(
                          selectedSource,
                          "interact",
                        )
                      }
                    >
                      Interact ↗
                    </button>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className="empty-inspector">
                <span>◇</span>
                <p>Select a source to edit its transform and audio.</p>
              </div>
            )}
          </section>

        </aside>
      </main>

      {sceneModalOpen ? (
        <SceneModal
          existingNames={studio.scenes.map((scene) => scene.name)}
          onClose={() => setSceneModalOpen(false)}
          onCreate={(name) =>
            studio.createScene(
              name,
              studio.transitions.studioModeEnabled ? "preview" : "program",
            )
          }
        />
      ) : null}

      {sourceModalOpen ? (
        <SourceModal
          onClose={() => setSourceModalOpen(false)}
          onCreate={studio.addSource}
        />
      ) : null}

      {streamModalOpen ? (
        <div
          className="modal-backdrop"
          onMouseDown={() => setStreamModalOpen(false)}
        >
          <form
            className="modal-card stream-modal"
            onSubmit={(event) => {
              event.preventDefault();
              if (
                window.confirm(
                  "This will begin broadcasting your OBS program output to Kick. Go live now?",
                )
              ) {
                void runAction(goLive);
              }
            }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">Final check</span>
                <h2>Go live on Kick</h2>
              </div>
              <span className="kick-badge large">K</span>
            </div>
            <label>
              Kick RTMPS server
              <input
                type="url"
                value={kickConfig.server}
                onChange={(event) =>
                  setKickConfig((config) => ({
                    ...config,
                    server: event.currentTarget.value,
                  }))
                }
                required
              />
            </label>
            <label>
              Stream key
              <div className="secret-field">
                <input
                  type={showKey ? "text" : "password"}
                  value={kickConfig.streamKey}
                  onChange={(event) =>
                    setKickConfig((config) => ({
                      ...config,
                      streamKey: event.currentTarget.value,
                    }))
                  }
                  autoComplete="off"
                  required
                  placeholder="Paste your Kick stream key"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((visible) => !visible)}
                >
                  {showKey ? "Hide" : "Show"}
                </button>
              </div>
            </label>
            <div className="security-note">
              <span>⌾</span>
              <p>
                Your stream key stays in memory for this session and is cleared
                from the OBS profile when streaming stops.
              </p>
            </div>
            <a
              className="dashboard-link"
              href="https://dashboard.kick.com/channel/stream"
              target="_blank"
              rel="noreferrer"
            >
              Open Kick Stream URL and Key ↗
            </a>
            <div className="modal-actions">
              <button
                type="button"
                className="button ghost"
                onClick={() => setStreamModalOpen(false)}
              >
                Cancel
              </button>
              <button
                className="button go-live"
                disabled={
                  !kickConfig.server.trim() || !kickConfig.streamKey.trim()
                }
              >
                <span className="live-dot" />
                Start broadcast
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}

export default App;
