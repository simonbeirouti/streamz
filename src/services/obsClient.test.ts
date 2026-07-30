import OBSWebSocket from "obs-websocket-js";
import { describe, expect, it, vi } from "vitest";
import { ObsStudioClient } from "./obsClient";

function clientWith(call: ReturnType<typeof vi.fn>) {
  return new ObsStudioClient({ call } as unknown as OBSWebSocket);
}

describe("ObsStudioClient entity semantics", () => {
  it("maps recording pause and resume events without an async state race", () => {
    const handlers = new Map<string, (event: never) => void>();
    const obs = {
      call: vi.fn(),
      on: vi.fn((event: string, handler: (payload: never) => void) => {
        handlers.set(event, handler);
      }),
    };
    const client = new ObsStudioClient(obs as never);
    const listener = vi.fn();
    client.subscribe(listener);
    (
      client as unknown as {
        bindEvents: () => void;
      }
    ).bindEvents();

    handlers.get("RecordStateChanged")?.({
      outputActive: true,
      outputState: "OBS_WEBSOCKET_OUTPUT_PAUSED",
      outputPath: "",
    } as never);
    expect(listener).toHaveBeenLastCalledWith({
      type: "recording",
      state: expect.objectContaining({ active: true, paused: true }),
    });

    handlers.get("RecordStateChanged")?.({
      outputActive: true,
      outputState: "OBS_WEBSOCKET_OUTPUT_RESUMED",
      outputPath: "",
    } as never);
    expect(listener).toHaveBeenLastCalledWith({
      type: "recording",
      state: expect.objectContaining({ active: true, paused: false }),
    });
  });

  it("creates a scene and selects the requested destination", async () => {
    const call = vi.fn(async (request: string) => {
      if (request === "CreateScene") return { sceneUuid: "scene-new" };
      return {};
    });
    const client = clientWith(call);

    await expect(client.createScene("New scene", "preview")).resolves.toEqual({
      name: "New scene",
      uuid: "scene-new",
    });
    expect(call).toHaveBeenNthCalledWith(1, "CreateScene", {
      sceneName: "New scene",
    });
    expect(call).toHaveBeenNthCalledWith(2, "SetCurrentPreviewScene", {
      sceneUuid: "scene-new",
    });
  });

  it("uses the runtime versioned camera kind", async () => {
    const call = vi.fn(async (request: string) => {
      if (request === "GetVersion") {
        return {
          obsVersion: "32.2.1",
          obsWebSocketVersion: "5.6.0",
          rpcVersion: 1,
          availableRequests: [],
          platform: "macos",
        };
      }
      if (request === "GetInputKindList") {
        return { inputKinds: ["macos-avcapture-fast", "browser_source"] };
      }
      throw new Error(`Unexpected request ${request}`);
    });

    await expect(clientWith(call).resolveInputKind("camera")).resolves.toBe(
      "macos-avcapture-fast",
    );
  });

  it("finds every scene-item reference to an input UUID", async () => {
    const call = vi.fn(async (request: string, args?: Record<string, unknown>) => {
      if (request === "GetSceneList") {
        return {
          currentProgramSceneName: "One",
          currentProgramSceneUuid: "scene-1",
          currentPreviewSceneName: null,
          currentPreviewSceneUuid: null,
          scenes: [
            { sceneName: "One", sceneUuid: "scene-1", sceneIndex: 0 },
            { sceneName: "Two", sceneUuid: "scene-2", sceneIndex: 1 },
          ],
        };
      }
      if (request === "GetSceneItemList") {
        return {
          sceneItems: [
            {
              sceneItemId: args?.sceneUuid === "scene-1" ? 4 : 9,
              sourceName: "Camera",
              sourceUuid: "input-1",
            },
          ],
        };
      }
      throw new Error(`Unexpected request ${request}`);
    });

    await expect(
      clientWith(call).getSourceReferenceReport({
        name: "Camera",
        uuid: "input-1",
      }),
    ).resolves.toMatchObject({
      shared: true,
      references: [
        { sceneItemId: 4 },
        { sceneItemId: 9 },
      ],
    });
  });

  it("deletes the underlying input by UUID in everywhere mode", async () => {
    const call = vi.fn(async () => undefined);
    await clientWith(call).removeSource(
      { name: "Scene", uuid: "scene-1" },
      {
        name: "Camera",
        uuid: "input-1",
        sceneItemId: 7,
      } as never,
      "everywhere",
    );
    expect(call).toHaveBeenCalledWith("RemoveInput", {
      inputUuid: "input-1",
    });
  });

  it("removes only the selected scene item in scene mode", async () => {
    const call = vi.fn(async () => undefined);
    await clientWith(call).removeSource(
      { name: "Scene", uuid: "scene-1" },
      {
        name: "Camera",
        uuid: "input-1",
        sceneItemId: 7,
      } as never,
      "scene",
    );
    expect(call).toHaveBeenCalledWith("RemoveSceneItem", {
      sceneUuid: "scene-1",
      sceneItemId: 7,
    });
  });

  it("omits disabled zero-sized bounds from OBS transform mutations", async () => {
    const call = vi.fn(async () => ({}));
    await clientWith(call).setSourceTransform(
      { name: "Scene", uuid: "scene-1" },
      7,
      {
        positionX: 240,
        positionY: 0,
        scaleX: 2.25,
        scaleY: 2.25,
        boundsType: "OBS_BOUNDS_NONE",
        boundsWidth: 0,
        boundsHeight: 0,
      },
    );

    expect(call).toHaveBeenCalledWith("SetSceneItemTransform", {
      sceneUuid: "scene-1",
      sceneItemId: 7,
      sceneItemTransform: {
        positionX: 240,
        positionY: 0,
        scaleX: 2.25,
        scaleY: 2.25,
        boundsType: "OBS_BOUNDS_NONE",
      },
    });
  });

  it("binds the first real macOS camera and its dependent format", async () => {
    vi.useFakeTimers();
    const call = vi.fn(async (request: string, args?: Record<string, unknown>) => {
      if (request === "GetInputList") return { inputs: [] };
      if (request === "CreateInput") {
        return { inputUuid: "input-1", sceneItemId: 7 };
      }
      if (request === "GetInputSettings") return { inputSettings: {} };
      if (request === "GetInputPropertiesListPropertyItems") {
        if (args?.propertyName === "device") {
          return {
            propertyItems: [
              { itemName: "Select device", itemValue: "", itemEnabled: true },
              {
                itemName: "FaceTime HD Camera",
                itemValue: "camera-1",
                itemEnabled: true,
              },
            ],
          };
        }
        if (args?.propertyName === "supported_format") {
          return {
            propertyItems: [
              {
                itemName: "1920x1080 30 FPS",
                itemValue: "format-1",
                itemEnabled: true,
              },
            ],
          };
        }
        throw new Error("Property is not a list");
      }
      if (request === "GetSceneItemTransform") {
        return {
          sceneItemTransform: {
            sourceWidth: 1920,
            sourceHeight: 1080,
            scaleX: 1,
            scaleY: 1,
          },
        };
      }
      if (request === "GetSceneItemList") {
        return {
          sceneItems: [
            {
              sceneItemId: 7,
              sceneItemIndex: 0,
              sourceName: "Camera",
              sourceUuid: "input-1",
              inputKind: "macos-avcapture-fast",
              sceneItemEnabled: true,
              sceneItemLocked: false,
              sceneItemTransform: {
                sourceWidth: 1920,
                sourceHeight: 1080,
                scaleX: 1,
                scaleY: 1,
              },
            },
          ],
        };
      }
      if (
        request === "SetInputSettings" ||
        request === "SetSceneItemEnabled" ||
        request === "SetSceneItemTransform"
      ) {
        return {};
      }
      throw new Error(`Unsupported in test: ${request}`);
    });

    const creation = clientWith(call).createInput({
      kind: "camera",
      name: "Camera",
      scene: { name: "Scene", uuid: "scene-1" },
      inputKind: "macos-avcapture-fast",
      settings: {},
      placement: "fit",
    });
    await vi.runAllTimersAsync();
    await creation;

    expect(call).toHaveBeenCalledWith(
      "SetInputSettings",
      expect.objectContaining({
        inputUuid: "input-1",
        inputSettings: {
          device: "camera-1",
          device_name: "FaceTime HD Camera",
        },
      }),
    );
    expect(call).toHaveBeenCalledWith(
      "SetInputSettings",
      expect.objectContaining({
        inputSettings: { supported_format: "format-1" },
      }),
    );
    vi.useRealTimers();
  });

  it("keeps a created source when its first video frame is delayed", async () => {
    vi.useFakeTimers();
    const call = vi.fn(async (request: string) => {
      if (request === "GetInputList") return { inputs: [] };
      if (request === "CreateInput") {
        return { inputUuid: "input-1", sceneItemId: 7 };
      }
      if (request === "SetSceneItemEnabled") return {};
      if (request === "GetSceneItemTransform") {
        return {
          sceneItemTransform: {
            sourceWidth: 0,
            sourceHeight: 0,
            scaleX: 1,
            scaleY: 1,
          },
        };
      }
      if (request === "GetSceneItemList") {
        return {
          sceneItems: [
            {
              sceneItemId: 7,
              sceneItemIndex: 0,
              sourceName: "Camera",
              sourceUuid: "input-1",
              inputKind: "macos-avcapture-fast",
              sceneItemEnabled: true,
              sceneItemLocked: false,
              sceneItemTransform: {
                sourceWidth: 0,
                sourceHeight: 0,
                scaleX: 1,
                scaleY: 1,
              },
            },
          ],
        };
      }
      throw new Error(`Unsupported in test: ${request}`);
    });

    const creation = clientWith(call).createInput({
      kind: "camera",
      name: "Camera",
      scene: { name: "Scene", uuid: "scene-1" },
      inputKind: "macos-avcapture-fast",
      settings: { device: "camera-1" },
      placement: "fit",
    });
    await vi.advanceTimersByTimeAsync(3_100);
    await expect(creation).resolves.toMatchObject({
      name: "Camera",
      sceneItemId: 7,
    });
    expect(call).not.toHaveBeenCalledWith("RemoveInput", expect.anything());
    vi.clearAllTimers();
    vi.useRealTimers();
  });
});
