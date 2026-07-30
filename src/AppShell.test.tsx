import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { useObsStudio } from "./hooks/useObsStudio";

vi.mock("./hooks/useObsStudio", () => ({
  useObsStudio: vi.fn(),
}));

const action = vi.fn(async () => undefined);

function studioState(live = false) {
  return {
    connection: "connected",
    preview: "ready",
    previewStream: null,
    previewImage: null,
    capabilities: {
      obsVersion: "32.2.1",
      websocketVersion: "5.7.4",
      rpcVersion: 1,
      platform: "macos",
      requests: ["StartReplayBuffer"],
      inputKinds: [],
    },
    scenes: [{ name: "Main", uuid: "scene-1", index: 0 }],
    currentScene: "Main",
    currentSceneRef: { name: "Main", uuid: "scene-1" },
    programScene: { name: "Main", uuid: "scene-1" },
    sources: [],
    selectedSourceId: null,
    setSelectedSourceId: vi.fn(),
    transitions: {
      available: [{ name: "Fade", configurable: true }],
      current: "Fade",
      durationMs: 300,
      studioModeEnabled: false,
      previewScene: null,
    },
    outputs: {},
    streamState: {
      active: live,
      reconnecting: false,
      durationMs: live ? 5_000 : 0,
      bytesSent: 0,
      skippedFrames: 0,
      totalFrames: 0,
      congestion: 0,
      lastError: null,
    },
    recordingState: {
      active: false,
      paused: false,
      durationMs: 0,
      bytes: 0,
      path: null,
      lastError: null,
    },
    replayBufferState: {
      active: false,
      lastSavedPath: null,
      lastError: null,
    },
    meters: {},
    error: null,
    clearError: vi.fn(),
    pendingActions: new Set<string>(),
    isPending: () => false,
    setupMessage: null,
    launch: action,
    reconnect: action,
    revealObs: action,
    installVirtualCamera: action,
    startPreview: action,
    stopPreview: action,
    createScene: action,
    renameScene: action,
    removeScene: action,
    selectScene: action,
    addSource: action,
    renameSource: action,
    duplicateSource: action,
    getSourceReferences: action,
    removeSource: action,
    setSourceEnabled: action,
    setSourceLocked: action,
    moveSource: action,
    setSourceTransform: action,
    applyPlacement: action,
    setSourceBlendMode: action,
    getInputProperties: vi.fn(async () => []),
    setInputProperty: action,
    setInputMute: action,
    setInputVolume: action,
    setInputAudioBalance: action,
    setInputAudioSyncOffset: action,
    setInputAudioMonitorType: action,
    triggerMediaAction: action,
    setMediaCursor: action,
    openInputDialog: action,
    setStudioModeEnabled: action,
    setCurrentTransition: action,
    setTransitionDuration: action,
    triggerTransition: action,
    startStream: action,
    stopStream: action,
    startRecording: action,
    stopRecording: action,
    setRecordingPaused: action,
    startReplayBuffer: action,
    stopReplayBuffer: action,
    saveReplayBuffer: action,
    shutdown: action,
  };
}

describe("App control surface", () => {
  beforeEach(() => {
    vi.mocked(useObsStudio).mockReturnValue(studioState() as never);
  });

  it("keeps only OBS, recording, and Kick controls in the header", () => {
    render(<App />);

    expect(
      screen.getByRole("button", { name: "Open OBS, preview ready" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Start recording" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go live" })).toHaveClass(
      "kick-live-control",
    );
    expect(screen.queryByText("Record & Replay")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Start replay buffer" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Transitions")).not.toBeInTheDocument();
    expect(screen.queryByText("Preview ready")).not.toBeInTheDocument();
  });

  it("reflects active and paused recording controls", () => {
    const active = studioState();
    active.recordingState = {
      ...active.recordingState,
      active: true,
      durationMs: 12_000,
    };
    vi.mocked(useObsStudio).mockReturnValue(active as never);
    const { rerender } = render(<App />);

    expect(
      screen.getByRole("button", { name: "Pause recording" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Stop recording" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("00:00:12");

    const paused = studioState();
    paused.recordingState = {
      ...paused.recordingState,
      active: true,
      paused: true,
      durationMs: 12_000,
    };
    vi.mocked(useObsStudio).mockReturnValue(paused as never);
    rerender(<App />);

    expect(
      screen.getByRole("button", { name: "Resume recording" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Paused");
  });

  it("shows a red timed Kick control while live", () => {
    vi.mocked(useObsStudio).mockReturnValue(studioState(true) as never);
    render(<App />);

    expect(
      screen.getByRole("button", { name: "LIVE · 00:00:05" }),
    ).toHaveClass("is-live");
  });

  it("opens the Kick setup modal from the dark Go live control", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Go live" }));

    expect(
      screen.getByRole("heading", { name: "Go live on Kick" }),
    ).toBeInTheDocument();
  });
});
