import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SceneModal, SourceModal } from "./App";

describe("SceneModal", () => {
  it("rejects a case-insensitive duplicate scene name", async () => {
    const create = vi.fn(async () => undefined);
    render(
      <SceneModal
        existingNames={["Main"]}
        onClose={() => undefined}
        onCreate={create}
      />,
    );

    fireEvent.change(screen.getByLabelText("Scene name"), {
      target: { value: " main " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add scene" }));

    expect(
      await screen.findByText("A scene with this name already exists."),
    ).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps the scene dialog open and displays an OBS failure", async () => {
    const create = vi.fn(async () => {
      throw new Error("OBS rejected the scene");
    });
    render(
      <SceneModal
        existingNames={[]}
        onClose={() => undefined}
        onCreate={create}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add scene" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "OBS rejected the scene",
    );
  });
});

describe("SourceModal", () => {
  it("creates a camera with the Fit placement default", async () => {
    const create = vi.fn(async () => undefined);
    render(<SourceModal onClose={() => undefined} onCreate={create} />);

    fireEvent.change(screen.getByLabelText("Source name"), {
      target: { value: "Main camera" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add source" }));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        kind: "camera",
        name: "Main camera",
        url: undefined,
        path: undefined,
        placement: "fit",
      }),
    );
  });

  it("passes browser URL and Fill placement", async () => {
    const create = vi.fn(async () => undefined);
    render(<SourceModal onClose={() => undefined} onCreate={create} />);

    fireEvent.click(screen.getByRole("button", { name: /Browser/ }));
    fireEvent.change(screen.getByLabelText("URL"), {
      target: { value: "https://example.com/overlay" },
    });
    fireEvent.change(screen.getByLabelText("Initial placement"), {
      target: { value: "fill" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add source" }));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "browser",
          url: "https://example.com/overlay",
          placement: "fill",
        }),
      ),
    );
  });
});
