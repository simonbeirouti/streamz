# Streamz–OBS parity matrix

Every Streamz control must have an OBS request, a state query, an event path,
and a tested failure state. UUID fields are preferred wherever OBS supports
them; names are compatibility fallbacks only.

| Streamz control | OBS request(s) | Query / event synchronization | Behavior |
| --- | --- | --- | --- |
| Launch / Advanced OBS | Tauri `launch_obs`, `reveal_obs` | process status, WebSocket close/error | Own only the launched child; reveal native OBS for escape-hatch dialogs |
| Start / Stop preview | `StartVirtualCam`, `StopVirtualCam`, `GetSourceScreenshot` fallback | `GetVirtualCamStatus`, `VirtualcamStateChanged` | Virtual Camera first, program screenshots as fallback |
| Create / rename / remove scene | `CreateScene`, `SetSceneName`, `RemoveScene` | scene list and scene events | UUID-first; never remove the last scene in UI |
| Program / preview scene | `SetCurrentProgramScene`, `SetCurrentPreviewScene` | current scene events | Preview selection is available in Studio Mode |
| Add source | `GetInputKindList`, `CreateInput`, `SetInputSettings`, `SetSceneItemTransform` | input/settings/active/transform events | Resolve the runtime kind, enable, await dimensions, then Fit or Fill |
| Visibility / lock / order | `SetSceneItemEnabled`, `SetSceneItemLocked`, `SetSceneItemIndex` | matching scene-item events | UI order is top-to-bottom while OBS indexes bottom-to-top |
| Rename / copy / reference | `SetInputName`, `CreateInput`, `DuplicateSceneItem` | input and scene-item events | Copy creates an independent input; Reference reuses the input |
| Remove source | `RemoveSceneItem`, `RemoveInput` | reference preflight across all scenes | Shared inputs prompt for current-scene or everywhere deletion |
| Transform | `SetSceneItemTransform` | `GetSceneItemTransform`, transform events | Fit, Fill, Center, Reset, position, scale, rotation, crop, alignment |
| Blend mode | `SetSceneItemBlendMode` | `GetSceneItemBlendMode` | Uses OBS blend identifiers |
| Input properties | `GetInputSettings`, `SetInputSettings`, list-property queries | `InputSettingsChanged` | Streamz renders known controls; native OBS dialog covers the remainder |
| Filters / interact | `OpenInputFiltersDialog`, `OpenInputInteractDialog` | OBS owns dialog state | Exact native OBS UI |
| Mute / volume / audio | input mute, volume, balance, sync, monitoring requests | matching audio events and meters | Mute is a real toggle; meters remain visual-only |
| Media | `TriggerMediaInputAction`, `SetMediaInputCursor` | media status and events | Play, pause, restart, stop, previous, next, seek |
| Studio Mode / transition | studio-mode and scene-transition requests | transition and studio-mode events | Select transition, duration, preview scene, trigger |
| Stream | stream-service settings and stream requests | stream state/status events | Kick secrets remain ephemeral and are cleared after stop |
| Recording | record start/stop/pause requests | record status/state events | Shows duration and last output path |
| Replay Buffer | replay start/stop/save requests | replay state/saved events | Disabled when the running OBS does not expose the requests |
