import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  startTransition,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { ObsStudioClient } from "../services/obsClient";
import type {
  AddSourceDraft,
  InputPropertyValue,
  KickStreamConfig,
  MediaAction,
  ObsCapabilityMap,
  ObsConnectionState,
  ObsEntityRef,
  ObsLaunchSession,
  ObsProcessStatus,
  OutputState,
  PlacementPreset,
  PreviewState,
  RecordingState,
  ReplayBufferState,
  Scene,
  SetupResult,
  Source,
  StreamState,
  TransitionState,
} from "../types/obs";

const initialStreamState: StreamState = {
  active: false,
  reconnecting: false,
  durationMs: 0,
  bytesSent: 0,
  skippedFrames: 0,
  totalFrames: 0,
  congestion: 0,
  lastError: null,
};

const initialRecordingState: RecordingState = {
  active: false,
  paused: false,
  durationMs: 0,
  bytes: 0,
  path: null,
  lastError: null,
};

const initialReplayState: ReplayBufferState = {
  active: false,
  lastSavedPath: null,
  lastError: null,
};

const initialOutputState: OutputState = {
  stream: initialStreamState,
  recording: initialRecordingState,
  replayBuffer: initialReplayState,
  virtualCameraActive: false,
};

const initialTransitionState: TransitionState = {
  available: [],
  current: "",
  durationMs: 300,
  studioModeEnabled: false,
  previewScene: null,
};

const wait = (milliseconds: number) =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));

function messageFrom(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function connectWithRetry(
  client: ObsStudioClient,
  session: ObsLaunchSession,
) {
  let lastError: unknown;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      await client.connect(
        session.websocketUrl,
        session.password,
        session.recordingPath,
      );
      return;
    } catch (error) {
      lastError = error;
      await client.disconnectSocket();
      if (isTauri()) {
        const status = await invoke<ObsProcessStatus>(
          "get_obs_process_status",
        ).catch(() => null);
        if (status && !status.running) {
          throw new Error("OBS exited before Streamz could connect.");
        }
      }
      await wait(500);
    }
  }
  throw (
    lastError ??
    new Error("OBS WebSocket did not become ready within 60 seconds.")
  );
}

export function useObsStudio() {
  const clientRef = useRef<ObsStudioClient | null>(null);
  const sessionRef = useRef<ObsLaunchSession | null>(null);
  const connectionTaskRef = useRef<Promise<void> | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectActionRef = useRef<() => void>(() => undefined);
  const autoLaunchRef = useRef(false);
  const autoPreviewStartedRef = useRef(false);
  const previewStartingRef = useRef(false);
  const previewStreamRef = useRef<MediaStream | null>(null);
  const snapshotTimerRef = useRef<number | null>(null);
  const snapshotPendingRef = useRef(false);
  const currentSceneRef = useRef<ObsEntityRef | null>(null);
  const refreshTimerRef = useRef<number | null>(null);
  const meterFrameRef = useRef<number | null>(null);
  const pendingMetersRef = useRef<Record<string, number>>({});

  if (!clientRef.current) clientRef.current = new ObsStudioClient();

  const [connection, setConnection] =
    useState<ObsConnectionState>("idle");
  const [preview, setPreview] = useState<PreviewState>("idle");
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<ObsCapabilityMap | null>(
    null,
  );
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [currentScene, setCurrentScene] = useState<ObsEntityRef | null>(null);
  const [programScene, setProgramScene] = useState<ObsEntityRef | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState<number | null>(null);
  const [transitions, setTransitions] =
    useState<TransitionState>(initialTransitionState);
  const [outputs, setOutputs] = useState<OutputState>(initialOutputState);
  const [meters, setMeters] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [pendingActions, setPendingActions] = useState<Set<string>>(
    () => new Set(),
  );
  const [setupMessage, setSetupMessage] = useState<string | null>(null);

  const refresh = useCallback(async (preferredScene?: ObsEntityRef | null) => {
    try {
      const snapshot = await clientRef.current!.getStudioSnapshot(
        preferredScene ?? currentSceneRef.current ?? undefined,
      );
      const activeScene =
        snapshot.scenes.find(
          (scene) =>
            scene.uuid &&
            scene.uuid ===
              (preferredScene ?? currentSceneRef.current)?.uuid,
        ) ??
        snapshot.scenes.find(
          (scene) =>
            scene.name ===
            (preferredScene ?? currentSceneRef.current)?.name,
        ) ??
        snapshot.scenes.find(
          (scene) => scene.uuid === snapshot.currentProgramScene?.uuid,
        ) ??
        snapshot.scenes.find(
          (scene) => scene.name === snapshot.currentProgramScene?.name,
        ) ??
        snapshot.scenes[0] ??
        null;
      currentSceneRef.current = activeScene;
      startTransition(() => {
        setCapabilities(snapshot.capabilities);
        setScenes(snapshot.scenes);
        setCurrentScene(activeScene);
        setProgramScene(snapshot.currentProgramScene);
        setSources(snapshot.sources);
        setTransitions(snapshot.transitions);
        setOutputs(snapshot.outputs);
        setSelectedSourceId((selected) =>
          snapshot.sources.some((source) => source.sceneItemId === selected)
            ? selected
            : (snapshot.sources[0]?.sceneItemId ?? null),
        );
      });
    } catch (refreshError) {
      setError(messageFrom(refreshError));
    }
  }, []);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current !== null) {
      window.clearTimeout(refreshTimerRef.current);
    }
    refreshTimerRef.current = window.setTimeout(() => void refresh(), 80);
  }, [refresh]);

  const beginConnection = useCallback((work: () => Promise<void>) => {
    if (connectionTaskRef.current) return connectionTaskRef.current;
    const task = work().finally(() => {
      if (connectionTaskRef.current === task) {
        connectionTaskRef.current = null;
      }
    });
    connectionTaskRef.current = task;
    return task;
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (reconnectTimerRef.current !== null) return;
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      reconnectActionRef.current();
    }, 2_000);
  }, []);

  const reconnect = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return;
    return beginConnection(async () => {
      setConnection("reconnecting");
      setError(null);
      try {
        await connectWithRetry(clientRef.current!, session);
        if (reconnectTimerRef.current !== null) {
          window.clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = null;
        }
        setConnection("connected");
        await refresh();
      } catch (reconnectError) {
        setConnection("error");
        setError(`OBS disconnected: ${messageFrom(reconnectError)}`);
        scheduleReconnect();
      }
    });
  }, [beginConnection, refresh, scheduleReconnect]);
  reconnectActionRef.current = () => void reconnect();

  useEffect(() => {
    const client = clientRef.current!;
    return client.subscribe((event) => {
      if (event.type === "refresh") scheduleRefresh();
      if (event.type === "stream") {
        setOutputs((state) => ({ ...state, stream: event.state }));
      }
      if (event.type === "recording") {
        setOutputs((state) => ({ ...state, recording: event.state }));
      }
      if (event.type === "replay") {
        setOutputs((state) => ({ ...state, replayBuffer: event.state }));
      }
      if (event.type === "virtual-camera") {
        setOutputs((state) => ({
          ...state,
          virtualCameraActive: event.active,
        }));
        if (!event.active && previewStreamRef.current) {
          previewStreamRef.current.getTracks().forEach((track) => track.stop());
          previewStreamRef.current = null;
          setPreviewStream(null);
          setPreview("idle");
        }
      }
      if (event.type === "closed") void reconnect();
      if (event.type === "error" && !connectionTaskRef.current) {
        setError(event.message);
      }
      if (event.type === "meters") {
        for (const meter of event.meters) {
          pendingMetersRef.current[meter.inputName] = meter.level;
        }
        if (meterFrameRef.current === null) {
          meterFrameRef.current = window.requestAnimationFrame(() => {
            setMeters({ ...pendingMetersRef.current });
            meterFrameRef.current = null;
          });
        }
      }
    });
  }, [reconnect, scheduleRefresh]);

  useEffect(
    () => () => {
      previewStreamRef.current?.getTracks().forEach((track) => track.stop());
      if (snapshotTimerRef.current !== null) {
        window.clearInterval(snapshotTimerRef.current);
      }
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
      }
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
      }
      if (meterFrameRef.current !== null) {
        window.cancelAnimationFrame(meterFrameRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!outputs.recording.active) return;
    let cancelled = false;
    const synchronizeRecording = async () => {
      const recording = await clientRef.current!
        .getRecordingState()
        .catch(() => null);
      if (!cancelled && recording) {
        setOutputs((state) => ({ ...state, recording }));
      }
    };
    const timer = window.setInterval(() => {
      void synchronizeRecording();
    }, 750);
    void synchronizeRecording();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [outputs.recording.active]);

  const runAction = useCallback(
    async <T,>(key: string, action: () => Promise<T>): Promise<T> => {
      setError(null);
      setPendingActions((current) => new Set(current).add(key));
      try {
        return await action();
      } catch (actionError) {
        setError(messageFrom(actionError));
        throw actionError;
      } finally {
        setPendingActions((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    },
    [],
  );

  const clearError = useCallback(() => setError(null), []);

  const stopSnapshotPreview = useCallback(() => {
    if (snapshotTimerRef.current !== null) {
      window.clearInterval(snapshotTimerRef.current);
      snapshotTimerRef.current = null;
    }
    snapshotPendingRef.current = false;
    setPreviewImage(null);
  }, []);

  const startSnapshotPreview = useCallback(async () => {
    stopSnapshotPreview();
    const capture = async () => {
      const scene = currentSceneRef.current;
      if (!scene || snapshotPendingRef.current) return;
      snapshotPendingRef.current = true;
      try {
        setPreviewImage(
          await clientRef.current!.getProgramScreenshot(scene),
        );
      } finally {
        snapshotPendingRef.current = false;
      }
    };
    await capture();
    snapshotTimerRef.current = window.setInterval(() => {
      void capture().catch(() => undefined);
    }, 150);
    setPreview("ready");
    setSetupMessage(null);
  }, [stopSnapshotPreview]);

  const launch = useCallback(async () => {
    return beginConnection(async () => {
      setConnection("launching");
      setError(null);
      setSetupMessage(null);
      try {
        if (!isTauri()) {
          throw new Error(
            "OBS lifecycle controls require the Tauri desktop runtime. Use `pnpm tauri dev`.",
          );
        }
        const session = await invoke<ObsLaunchSession>("launch_obs");
        sessionRef.current = session;
        setConnection("connecting");
        await connectWithRetry(clientRef.current!, session);
        if (reconnectTimerRef.current !== null) {
          window.clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = null;
        }
        setConnection("connected");
        await refresh();
      } catch (launchError) {
        setConnection("error");
        setError(messageFrom(launchError));
        if (sessionRef.current) scheduleReconnect();
      }
    });
  }, [beginConnection, refresh, scheduleReconnect]);

  useEffect(() => {
    if (autoLaunchRef.current) return;
    autoLaunchRef.current = true;
    if (isTauri()) {
      void launch();
      return;
    }
    setConnection("error");
    setError(
      "OBS auto-start requires the Tauri desktop runtime. Use `pnpm tauri dev`.",
    );
  }, [launch]);

  const startPreview = useCallback(async () => {
    if (
      previewStartingRef.current ||
      previewStreamRef.current ||
      snapshotTimerRef.current !== null
    ) {
      return;
    }
    previewStartingRef.current = true;
    setPreview("starting");
    setError(null);
    setSetupMessage(null);
    stopSnapshotPreview();
    try {
      try {
        await clientRef.current!.startVirtualCamera();
      } catch {
        await startSnapshotPreview();
        return;
      }
      await wait(800);
      let devices = await navigator.mediaDevices.enumerateDevices();
      let obsCamera = devices.find(
        (device) =>
          device.kind === "videoinput" &&
          device.label.toLowerCase().includes("obs virtual camera"),
      );
      if (!obsCamera) {
        const permissionProbe = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false,
        });
        permissionProbe.getTracks().forEach((track) => track.stop());
        devices = await navigator.mediaDevices.enumerateDevices();
        obsCamera = devices.find(
          (device) =>
            device.kind === "videoinput" &&
            device.label.toLowerCase().includes("obs virtual camera"),
        );
      }
      if (!obsCamera) {
        await clientRef.current!.stopVirtualCamera().catch(() => undefined);
        await startSnapshotPreview();
        return;
      }
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: { exact: obsCamera.deviceId },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30 },
        },
        audio: false,
      });
      previewStreamRef.current = mediaStream;
      setPreviewStream(mediaStream);
      setPreviewImage(null);
      setPreview("ready");
    } catch (previewError) {
      try {
        await startSnapshotPreview();
      } catch {
        const denied =
          previewError instanceof DOMException &&
          previewError.name === "NotAllowedError";
        setPreview(denied ? "permission-required" : "error");
        setError(messageFrom(previewError));
      }
    } finally {
      previewStartingRef.current = false;
    }
  }, [startSnapshotPreview, stopSnapshotPreview]);

  const stopPreview = useCallback(async () => {
    stopSnapshotPreview();
    previewStreamRef.current?.getTracks().forEach((track) => track.stop());
    previewStreamRef.current = null;
    setPreviewStream(null);
    await clientRef.current!.stopVirtualCamera().catch(() => undefined);
    setPreview("idle");
  }, [stopSnapshotPreview]);

  useEffect(() => {
    if (connection !== "connected") {
      autoPreviewStartedRef.current = false;
      return;
    }
    if (
      sources.length > 0 &&
      preview === "idle" &&
      !autoPreviewStartedRef.current
    ) {
      autoPreviewStartedRef.current = true;
      void startPreview();
    }
  }, [connection, preview, sources.length, startPreview]);

  const installVirtualCamera = useCallback(async () => {
    const result = await invoke<SetupResult>("install_virtual_camera");
    setSetupMessage(result.message);
  }, []);

  const revealObs = useCallback(async () => {
    await invoke("reveal_obs");
  }, []);

  const requireScene = useCallback(() => {
    const scene = currentSceneRef.current;
    if (!scene) throw new Error("Select an OBS scene first.");
    return scene;
  }, []);

  const createScene = useCallback(
    (name: string, target: "program" | "preview" = "program") =>
      runAction("scene:create", async () => {
        const scene = await clientRef.current!.createScene(name, target);
        currentSceneRef.current = scene;
        await refresh(scene);
        return scene;
      }),
    [refresh, runAction],
  );

  const renameScene = useCallback(
    (scene: ObsEntityRef, nextName: string) =>
      runAction("scene:rename", async () => {
        await clientRef.current!.renameScene(scene, nextName);
        await refresh({ ...scene, name: nextName });
      }),
    [refresh, runAction],
  );

  const removeScene = useCallback(
    (scene: ObsEntityRef) =>
      runAction("scene:remove", async () => {
        await clientRef.current!.removeScene(scene);
        currentSceneRef.current = null;
        await refresh();
      }),
    [refresh, runAction],
  );

  const selectScene = useCallback(
    (scene: ObsEntityRef, target: "program" | "preview" = "program") =>
      runAction(`scene:${target}`, async () => {
        if (target === "preview") {
          await clientRef.current!.setCurrentPreviewScene(scene);
        } else {
          await clientRef.current!.setCurrentProgramScene(scene);
        }
        currentSceneRef.current = scene;
        await refresh(scene);
      }),
    [refresh, runAction],
  );

  const addSource = useCallback(
    (draft: AddSourceDraft) =>
      runAction("source:add", async () => {
        await clientRef.current!.addSource(requireScene(), draft);
        await refresh();
      }),
    [refresh, requireScene, runAction],
  );

  const renameSource = useCallback(
    (source: ObsEntityRef, newInputName: string) =>
      runAction("source:rename", async () => {
        await clientRef.current!.renameSource(source, newInputName);
        await refresh();
      }),
    [refresh, runAction],
  );

  const duplicateSource = useCallback(
    (source: Source, mode: "independent" | "reference") =>
      runAction("source:duplicate", async () => {
        const scene = requireScene();
        if (mode === "reference") {
          await clientRef.current!.duplicateSourceReference(
            scene,
            source.sceneItemId,
          );
        } else {
          await clientRef.current!.duplicateInput(scene, source);
        }
        await refresh();
      }),
    [refresh, requireScene, runAction],
  );

  const getSourceReferences = useCallback((source: ObsEntityRef) => {
    return clientRef.current!.getSourceReferenceReport(source);
  }, []);

  const removeSource = useCallback(
    (source: Source, mode: "scene" | "everywhere") =>
      runAction("source:remove", async () => {
        await clientRef.current!.removeSource(requireScene(), source, mode);
        await refresh();
      }),
    [refresh, requireScene, runAction],
  );

  const setSourceEnabled = useCallback(
    (source: Source, enabled: boolean) =>
      runAction("source:visibility", async () => {
        await clientRef.current!.setSourceEnabled(
          requireScene(),
          source.sceneItemId,
          enabled,
        );
        setSources((current) =>
          current.map((item) =>
            item.sceneItemId === source.sceneItemId
              ? { ...item, enabled }
              : item,
          ),
        );
      }),
    [requireScene, runAction],
  );

  const setSourceLocked = useCallback(
    (source: Source, locked: boolean) =>
      runAction("source:lock", async () => {
        await clientRef.current!.setSourceLocked(
          requireScene(),
          source.sceneItemId,
          locked,
        );
        setSources((current) =>
          current.map((item) =>
            item.sceneItemId === source.sceneItemId
              ? { ...item, locked }
              : item,
          ),
        );
      }),
    [requireScene, runAction],
  );

  const moveSource = useCallback(
    (source: Source, direction: "up" | "down") =>
      runAction("source:reorder", async () => {
        const nextIndex = Math.max(
          0,
          Math.min(
            sources.length - 1,
            source.sceneItemIndex + (direction === "up" ? 1 : -1),
          ),
        );
        await clientRef.current!.setSourceIndex(
          requireScene(),
          source.sceneItemId,
          nextIndex,
        );
        await refresh();
      }),
    [refresh, requireScene, runAction, sources.length],
  );

  const setSourceTransform = useCallback(
    (sceneItemId: number, transform: Partial<Source["transform"]>) =>
      runAction("source:transform", async () => {
        await clientRef.current!.setSourceTransform(
          requireScene(),
          sceneItemId,
          transform,
        );
        setSources((current) =>
          current.map((source) =>
            source.sceneItemId === sceneItemId
              ? {
                  ...source,
                  transform: { ...source.transform, ...transform },
                }
              : source,
          ),
        );
      }),
    [requireScene, runAction],
  );

  const applyPlacement = useCallback(
    (source: Source, preset: PlacementPreset) =>
      runAction(`source:${preset}`, async () => {
        await clientRef.current!.setPlacement(
          requireScene(),
          source.sceneItemId,
          source.transform,
          preset,
        );
        await refresh();
      }),
    [refresh, requireScene, runAction],
  );

  const setSourceBlendMode = useCallback(
    (source: Source, blendMode: string) =>
      runAction("source:blend", async () => {
        await clientRef.current!.setSourceBlendMode(
          requireScene(),
          source.sceneItemId,
          blendMode,
        );
        await refresh();
      }),
    [refresh, requireScene, runAction],
  );

  const getInputProperties = useCallback((source: Source) => {
    return clientRef.current!.getInputProperties(source, source.sourceKind);
  }, []);

  const setInputProperty = useCallback(
    (source: Source, propertyName: string, value: InputPropertyValue) =>
      runAction("input:property", async () => {
        await clientRef.current!.setInputProperty(
          source,
          propertyName,
          value,
        );
        await refresh();
      }),
    [refresh, runAction],
  );

  const setInputMute = useCallback(
    (source: Source, muted: boolean) =>
      runAction("audio:mute", async () => {
        await clientRef.current!.setInputMute(source, muted);
        await refresh();
      }),
    [refresh, runAction],
  );

  const setInputVolume = useCallback(
    (source: Source, volumeDb: number) =>
      runAction("audio:volume", async () => {
        await clientRef.current!.setInputVolume(source, volumeDb);
        await refresh();
      }),
    [refresh, runAction],
  );

  const setInputAudioBalance = useCallback(
    (source: Source, balance: number) =>
      runAction("audio:balance", async () => {
        await clientRef.current!.setInputAudioBalance(source, balance);
        await refresh();
      }),
    [refresh, runAction],
  );

  const setInputAudioSyncOffset = useCallback(
    (source: Source, offsetMs: number) =>
      runAction("audio:sync", async () => {
        await clientRef.current!.setInputAudioSyncOffset(source, offsetMs);
        await refresh();
      }),
    [refresh, runAction],
  );

  const setInputAudioMonitorType = useCallback(
    (source: Source, monitorType: string) =>
      runAction("audio:monitor", async () => {
        await clientRef.current!.setInputAudioMonitorType(source, monitorType);
        await refresh();
      }),
    [refresh, runAction],
  );

  const triggerMediaAction = useCallback(
    (source: Source, action: MediaAction) =>
      runAction("media:action", async () => {
        await clientRef.current!.triggerMediaAction(source, action);
        await refresh();
      }),
    [refresh, runAction],
  );

  const setMediaCursor = useCallback(
    (source: Source, cursorMs: number) =>
      runAction("media:seek", async () => {
        await clientRef.current!.setMediaCursor(source, cursorMs);
        await refresh();
      }),
    [refresh, runAction],
  );

  const openInputDialog = useCallback(
    (
      source: Source,
      dialog: "properties" | "filters" | "interact",
    ) =>
      runAction(`input:${dialog}`, async () => {
        if (dialog === "properties") {
          await clientRef.current!.openInputProperties(source);
        } else if (dialog === "filters") {
          await clientRef.current!.openInputFilters(source);
        } else {
          await clientRef.current!.openInputInteract(source);
        }
        if (isTauri()) await invoke("reveal_obs").catch(() => undefined);
      }),
    [runAction],
  );

  const setStudioModeEnabled = useCallback(
    (enabled: boolean) =>
      runAction("studio:mode", async () => {
        await clientRef.current!.setStudioModeEnabled(enabled);
        await refresh();
      }),
    [refresh, runAction],
  );

  const setCurrentTransition = useCallback(
    (name: string) =>
      runAction("transition:select", async () => {
        await clientRef.current!.setCurrentTransition(name);
        await refresh();
      }),
    [refresh, runAction],
  );

  const setTransitionDuration = useCallback(
    (durationMs: number) =>
      runAction("transition:duration", async () => {
        await clientRef.current!.setTransitionDuration(durationMs);
        await refresh();
      }),
    [refresh, runAction],
  );

  const triggerTransition = useCallback(
    () =>
      runAction("transition:trigger", async () => {
        await clientRef.current!.triggerTransition();
        await refresh();
      }),
    [refresh, runAction],
  );

  const startStream = useCallback(
    (config: KickStreamConfig) =>
      runAction("output:stream", async () => {
        await clientRef.current!.startStream(config);
        const stream = await clientRef.current!.getStreamState();
        setOutputs((state) => ({
          ...state,
          stream,
        }));
      }),
    [runAction],
  );

  const stopStream = useCallback(
    () =>
      runAction("output:stream", async () => {
        await clientRef.current!.stopStream();
        setOutputs((state) => ({
          ...state,
          stream: initialStreamState,
        }));
      }),
    [runAction],
  );

  const startRecording = useCallback(
    () =>
      runAction("output:record", async () => {
        await clientRef.current!.startRecording();
        const recording = await clientRef.current!.getRecordingState();
        setOutputs((state) => ({ ...state, recording }));
      }),
    [runAction],
  );

  const stopRecording = useCallback(
    () =>
      runAction("output:record", async () => {
        await clientRef.current!.stopRecording();
        const recording = await clientRef.current!.getRecordingState();
        setOutputs((state) => ({ ...state, recording }));
      }),
    [runAction],
  );

  const setRecordingPaused = useCallback(
    (paused: boolean) =>
      runAction("output:record-pause", async () => {
        await clientRef.current!.setRecordingPaused(paused);
        const recording = await clientRef.current!.getRecordingState();
        setOutputs((state) => ({ ...state, recording }));
      }),
    [runAction],
  );

  const startReplayBuffer = useCallback(
    () =>
      runAction("output:replay", async () => {
        await clientRef.current!.startReplayBuffer();
        await refresh();
      }),
    [refresh, runAction],
  );

  const stopReplayBuffer = useCallback(
    () =>
      runAction("output:replay", async () => {
        await clientRef.current!.stopReplayBuffer();
        await refresh();
      }),
    [refresh, runAction],
  );

  const saveReplayBuffer = useCallback(
    () =>
      runAction("output:replay-save", async () => {
        await clientRef.current!.saveReplayBuffer();
      }),
    [runAction],
  );

  const shutdown = useCallback(async () => {
    stopSnapshotPreview();
    previewStreamRef.current?.getTracks().forEach((track) => track.stop());
    sessionRef.current = null;
    await clientRef.current!.disconnect().catch(() => undefined);
    if (isTauri()) await invoke("shutdown_obs", { force: true });
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    autoPreviewStartedRef.current = false;
    setConnection("idle");
    setPreview("idle");
  }, [stopSnapshotPreview]);

  return {
    connection,
    preview,
    previewStream,
    previewImage,
    capabilities,
    scenes,
    currentScene: currentScene?.name ?? "",
    currentSceneRef: currentScene,
    programScene,
    sources,
    selectedSourceId,
    setSelectedSourceId,
    transitions,
    outputs,
    streamState: outputs.stream,
    recordingState: outputs.recording,
    replayBufferState: outputs.replayBuffer,
    meters,
    error,
    clearError,
    pendingActions,
    isPending: (key: string) => pendingActions.has(key),
    setupMessage,
    launch,
    reconnect,
    revealObs,
    installVirtualCamera,
    startPreview,
    stopPreview,
    createScene,
    renameScene,
    removeScene,
    selectScene,
    addSource,
    renameSource,
    duplicateSource,
    getSourceReferences,
    removeSource,
    setSourceEnabled,
    setSourceLocked,
    moveSource,
    setSourceTransform,
    applyPlacement,
    setSourceBlendMode,
    getInputProperties,
    setInputProperty,
    setInputMute,
    setInputVolume,
    setInputAudioBalance,
    setInputAudioSyncOffset,
    setInputAudioMonitorType,
    triggerMediaAction,
    setMediaCursor,
    openInputDialog,
    setStudioModeEnabled,
    setCurrentTransition,
    setTransitionDuration,
    triggerTransition,
    startStream,
    stopStream,
    startRecording,
    stopRecording,
    setRecordingPaused,
    startReplayBuffer,
    stopReplayBuffer,
    saveReplayBuffer,
    shutdown,
    refresh,
  };
}
